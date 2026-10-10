// Citizen reports + announcements for SWIDS. Plugs into the existing server.js.
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const STATUSES = ["Submitted", "Received", "In progress", "Resolved", "Rejected"];
const CATEGORIES = ["Service complaint", "Infrastructure", "Security", "Health", "Agriculture", "Suggestion", "Other"];
const TYPES = ["General", "Emergency", "Event", "Service notice"];
const WHOLE = "Whole Woreda";

async function initTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS citizen_reports (
      id TEXT PRIMARY KEY,
      tracking_no TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      kebele TEXT NOT NULL,
      location_detail TEXT DEFAULT '',
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      phone TEXT,
      priority TEXT NOT NULL DEFAULT 'Normal',
      status TEXT NOT NULL DEFAULT 'Submitted',
      assigned_dept TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_updates (
      id SERIAL PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES citizen_reports(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      note TEXT DEFAULT '',
      is_public BOOLEAN NOT NULL DEFAULT true,
      by_email TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title_am TEXT DEFAULT '',
      title_en TEXT NOT NULL,
      body_am TEXT DEFAULT '',
      body_en TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'General',
      audience TEXT NOT NULL DEFAULT 'Whole Woreda',
      publish_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cr_kebele_status ON citizen_reports (kebele, status);
    CREATE INDEX IF NOT EXISTS idx_ann_pub ON announcements (publish_at);
  `);
}

// Random, hard-to-guess tracking number (so strangers cannot browse other people's reports).
function newTrackingNo() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
  return `SW-${new Date().getFullYear()}-${s}`;
}

function mount(app, { pool, wrap, requireAuth, cleanText }) {
  const requireStaff = (req, res, next) =>
    ["admin", "kebele_officer"].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: "Staff access required." });

  // admin sees all; kebele officer only their kebele; no kebele assigned = nothing.
  function scope(user, params) {
    if (user.role === "admin") return "TRUE";
    if (!user.kebele) return "FALSE";
    params.push(user.kebele);
    return `kebele = $${params.length}`;
  }
  const toDate = v => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };
  async function kebeleExists(name) {
    const total = await pool.query("SELECT COUNT(*)::int n FROM kebeles WHERE active = true");
    if (total.rows[0].n === 0) return true; // list not set up yet
    return (await pool.query("SELECT 1 FROM kebeles WHERE name=$1 AND active=true", [name])).rowCount > 0;
  }

  const submitLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many reports from this connection. Try again later." } });
  const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many lookups. Try again later." } });

  // ---- public: kebele list for dropdowns ----
  app.get("/api/public/kebeles", wrap(async (req, res) => {
    const { rows } = await pool.query("SELECT name FROM kebeles WHERE active = true ORDER BY name");
    res.json({ kebeles: rows.map(r => r.name) });
  }));

  // ---- public: submit a report (no login) ----
  app.post("/api/citizen-reports", submitLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const title = cleanText(b.title, 150), kebele = cleanText(b.kebele, 100);
    if (!title) return res.status(400).json({ error: "Title is required." });
    if (!kebele || !(await kebeleExists(kebele))) return res.status(400).json({ error: "Choose a Kebele from the list." });
    if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "Choose a valid category." });
    const anonymous = Boolean(b.anonymous);
    let phone = anonymous ? null : cleanText(b.phone, 20).replace(/\s+/g, "") || null;
    if (phone && !/^(?:\+251|0)[79]\d{8}$/.test(phone)) return res.status(400).json({ error: "Phone must look like 09XXXXXXXX." });

    for (let attempt = 0; attempt < 5; attempt++) {
      const client = await pool.connect();
      try {
        const id = crypto.randomUUID(), no = newTrackingNo();
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO citizen_reports (id,tracking_no,category,kebele,location_detail,title,description,phone,priority)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, no, b.category, kebele, cleanText(b.locationDetail, 200), title, cleanText(b.description, 3000), phone,
           b.priority === "Urgent" ? "Urgent" : "Normal"]);
        await client.query("INSERT INTO report_updates (report_id,status,note) VALUES ($1,'Submitted','Report submitted')", [id]);
        await client.query("COMMIT");
        return res.status(201).json({ trackingNo: no });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        if (err.code !== "23505") throw err; // tracking number collision: retry
      } finally { client.release(); }
    }
    res.status(500).json({ error: "Could not create a tracking number. Try again." });
  }));

  // ---- public: track by number (no phone, no internal notes) ----
  app.get("/api/citizen-reports/track/:no", trackLimiter, wrap(async (req, res) => {
    const r = (await pool.query(
      `SELECT id, tracking_no, category, kebele, title, priority, status, created_at, updated_at
       FROM citizen_reports WHERE tracking_no = $1`, [String(req.params.no).toUpperCase().slice(0, 30)])).rows[0];
    if (!r) return res.status(404).json({ error: "Not found." });
    const updates = (await pool.query(
      "SELECT status, note, created_at FROM report_updates WHERE report_id=$1 AND is_public=true ORDER BY id", [r.id])).rows;
    delete r.id;
    res.json({ report: { ...r, updates } });
  }));

  // ---- staff: inbox, update, stats ----
  app.get("/api/citizen-reports", requireAuth, requireStaff, wrap(async (req, res) => {
    const params = [];
    const where = [scope(req.user, params)];
    const k = cleanText(req.query.kebele, 100);
    if (req.user.role === "admin" && k && k !== "All") { params.push(k); where.push(`kebele = $${params.length}`); }
    if (STATUSES.includes(req.query.status)) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (CATEGORIES.includes(req.query.category)) { params.push(req.query.category); where.push(`category = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT id, tracking_no, category, kebele, location_detail, title, description, phone, priority, status,
              assigned_dept, created_at, updated_at
       FROM citizen_reports WHERE ${where.join(" AND ")}
       ORDER BY (priority='Urgent' AND status NOT IN ('Resolved','Rejected')) DESC, created_at DESC LIMIT 200`, params);
    res.json({ reports: rows });
  }));

  app.patch("/api/citizen-reports/:id", requireAuth, requireStaff, wrap(async (req, res) => {
    const params = [req.params.id];
    const cur = (await pool.query(`SELECT * FROM citizen_reports WHERE id=$1 AND ${scope(req.user, params)}`, params)).rows[0];
    if (!cur) return res.status(404).json({ error: "Report not found." });
    const b = req.body || {};
    const status = b.status === undefined ? cur.status : b.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status." });
    const note = cleanText(b.note, 1000);
    if (status === "Rejected" && !note) return res.status(400).json({ error: "A reason is required to reject a report." });
    const dept = b.assignedDept === undefined ? cur.assigned_dept : cleanText(b.assignedDept, 80);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE citizen_reports SET status=$2, assigned_dept=$3, updated_at=now() WHERE id=$1", [cur.id, status, dept]);
      if (note || status !== cur.status)
        await client.query("INSERT INTO report_updates (report_id,status,note,is_public,by_email) VALUES ($1,$2,$3,$4,$5)",
          [cur.id, status, note, b.public !== false, req.user.email]);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK").catch(() => {}); throw err; } finally { client.release(); }
    res.json({ ok: true });
  }));

  app.get("/api/citizen-reports-stats", requireAuth, requireStaff, wrap(async (req, res) => {
    const p1 = [], w = scope(req.user, p1);
    const tot = (await pool.query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status NOT IN ('Resolved','Rejected'))::int open,
              COUNT(*) FILTER (WHERE status='Resolved')::int resolved
       FROM citizen_reports WHERE ${w}`, p1)).rows[0];
    const p2 = [], w2 = scope(req.user, p2);
    const avg = (await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (u.t - r.created_at)) / 86400) d
       FROM citizen_reports r
       JOIN LATERAL (SELECT MIN(created_at) t FROM report_updates WHERE report_id = r.id AND status='Resolved') u ON u.t IS NOT NULL
       WHERE r.status='Resolved' AND ${w2.replace(/\bkebele\b/, "r.kebele")}`, p2)).rows[0].d;
    const p3 = [], w3 = scope(req.user, p3);
    const perKebele = (await pool.query(
      `SELECT kebele, COUNT(*)::int received, COUNT(*) FILTER (WHERE status='Resolved')::int resolved
       FROM citizen_reports WHERE ${w3} GROUP BY kebele ORDER BY kebele`, p3)).rows;
    res.json({ ...tot, avgResolutionDays: avg == null ? null : Number(Number(avg).toFixed(1)), perKebele });
  }));

  // ---- announcements ----
  // Public read: the audiences the visitor follows (sent as "A|B|C") plus all Emergency items.
  app.get("/api/announcements", wrap(async (req, res) => {
    const aud = String(req.query.audiences || WHOLE).split("|").map(s => s.trim().slice(0, 100)).filter(Boolean).slice(0, 30);
    const { rows } = await pool.query(
      `SELECT id, title_am, title_en, body_am, body_en, type, audience, publish_at, expires_at
       FROM announcements
       WHERE publish_at <= now() AND (expires_at IS NULL OR expires_at > now())
         AND (audience = ANY($1::text[]) OR type = 'Emergency')
       ORDER BY publish_at DESC LIMIT 100`, [aud]);
    res.json({ announcements: rows });
  }));

  app.post("/api/announcements", requireAuth, requireStaff, wrap(async (req, res) => {
    const b = req.body || {};
    const titleEn = cleanText(b.titleEn, 150);
    if (!titleEn) return res.status(400).json({ error: "English title is required." });
    const type = b.type || "General";
    if (!TYPES.includes(type)) return res.status(400).json({ error: "Invalid type." });
    let audience = cleanText(b.audience, 100) || (req.user.role === "admin" ? WHOLE : req.user.kebele);
    if (req.user.role === "kebele_officer") {
      if (!req.user.kebele) return res.status(400).json({ error: "Your account has no kebele assigned." });
      if (audience !== req.user.kebele) return res.status(403).json({ error: "You can post only to your own kebele." });
    } else if (audience !== WHOLE && !(await kebeleExists(audience))) {
      return res.status(400).json({ error: "Audience must be Whole Woreda or a Kebele from the list." });
    }
    const { rows } = await pool.query(
      `INSERT INTO announcements (title_am,title_en,body_am,body_en,type,audience,publish_at,expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8::timestamptz,$9) RETURNING id`,
      [cleanText(b.titleAm, 150), titleEn, cleanText(b.bodyAm, 3000), cleanText(b.bodyEn, 3000), type, audience,
       b.publishAt ? toDate(b.publishAt) : null, b.expiresAt ? toDate(b.expiresAt) : null, req.user.email]);
    res.status(201).json({ id: rows[0].id });
  }));

  app.delete("/api/announcements/:id", requireAuth, requireStaff, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
    const params = [id];
    let extra = "";
    if (req.user.role !== "admin") { params.push(req.user.kebele || ""); extra = " AND audience = $2"; }
    const { rowCount } = await pool.query(`DELETE FROM announcements WHERE id=$1${extra}`, params);
    if (!rowCount) return res.status(404).json({ error: "Announcement not found." });
    res.json({ ok: true });
  }));
}

module.exports = { initTables, mount, WHOLE, STATUSES, CATEGORIES, TYPES };
