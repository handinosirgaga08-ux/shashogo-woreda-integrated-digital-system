// Citizen reports + announcements for SWIDS. Plugs into the existing server.js.
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const STATUSES = ["Submitted", "Received", "In progress", "On hold", "Resolved", "Rejected"];
const CLOSED = ["Resolved", "Rejected"];
const CATEGORIES = ["Service complaint", "Infrastructure", "Water", "Road and transport", "Education",
  "Security", "Health", "Agriculture", "Suggestion", "Other"];
const TYPES = ["General", "Emergency", "Event", "Service notice"];
const WHOLE = "Whole Woreda";
const ALL_KEBELES = "All Kebeles";
const ALL_SECTORS = "All Sectors";

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
    -- New columns (safe to run on an existing database)
    ALTER TABLE citizen_reports ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE citizen_reports ADD COLUMN IF NOT EXISTS assigned_to TEXT NOT NULL DEFAULT '';
    ALTER TABLE citizen_reports ADD COLUMN IF NOT EXISTS due_date DATE;
    ALTER TABLE citizen_reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

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
    CREATE INDEX IF NOT EXISTS idx_cr_assigned ON citizen_reports (assigned_to);
    CREATE INDEX IF NOT EXISTS idx_cr_created ON citizen_reports (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ann_pub ON announcements (publish_at);
    CREATE TABLE IF NOT EXISTS report_photos (
      id SERIAL PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES citizen_reports(id) ON DELETE CASCADE,
      mime TEXT NOT NULL DEFAULT 'image/jpeg',
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_photos_report ON report_photos (report_id);
    CREATE INDEX IF NOT EXISTS idx_updates_report ON report_updates (report_id);
    CREATE TABLE IF NOT EXISTS periodic_reports (
      id TEXT PRIMARY KEY,
      unit_type TEXT NOT NULL CHECK (unit_type IN ('kebele','sector')),
      unit_name TEXT NOT NULL,
      period_type TEXT NOT NULL CHECK (period_type IN ('Monthly','Quarterly')),
      period_label TEXT NOT NULL,
      summary TEXT NOT NULL,
      achievements TEXT DEFAULT '',
      challenges TEXT DEFAULT '',
      next_plan TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Submitted',
      feedback TEXT DEFAULT '',
      submitted_by TEXT NOT NULL,
      submitted_name TEXT DEFAULT '',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (unit_type, unit_name, period_type, period_label)
    );
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
  // Editors: can change reports and post announcements.
  const requireStaff = (req, res, next) =>
    ["admin", "kebele_officer"].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: "Staff access required." });
  // Viewers: editors plus sector heads (read-only on citizen reports).
  const requireViewer = (req, res, next) =>
    ["admin", "kebele_officer", "sector_head"].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: "Staff access required." });

  // admin and sector heads see all; kebele officer only their kebele; no kebele assigned = nothing.
  // `col` lets callers qualify the column (e.g. "r.kebele") when the query uses a table alias.
  function scope(user, params, col = "kebele") {
    if (user.role === "admin" || user.role === "sector_head") return "TRUE";
    if (!user.kebele) return "FALSE";
    params.push(user.kebele);
    return `${col} = $${params.length}`;
  }
  // Returns an ISO string, or null for empty input. Returns undefined when the value is present but not a valid date.
  const toDate = v => {
    if (v === undefined || v === null || v === "") return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  };
  // YYYY-MM-DD only. null for empty, undefined for invalid.
  const toDay = v => {
    if (v === undefined || v === null || v === "") return null;
    const s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
  };
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
  const intParam = (v, def, min, max) => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? def : Math.min(max, Math.max(min, n));
  };

  async function sectorExists(name) {
    const total = await pool.query("SELECT COUNT(*)::int n FROM sectors WHERE active = true");
    if (total.rows[0].n === 0) return false; // no sectors set up: nothing to match
    return (await pool.query("SELECT 1 FROM sectors WHERE name=$1 AND active=true", [name])).rowCount > 0;
  }
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

  // ---- public: sector list for announcement audiences ----
  app.get("/api/public/sectors", wrap(async (req, res) => {
    const { rows } = await pool.query("SELECT name FROM sectors WHERE active = true ORDER BY name");
    res.json({ sectors: rows.map(r => r.name) });
  }));

  // ---- public: lists the report form needs (categories, statuses) ----
  app.get("/api/public/report-options", wrap(async (req, res) => {
    res.json({ categories: CATEGORIES, statuses: STATUSES });
  }));

  // ---- public: submit a report (no login) ----
  app.post("/api/citizen-reports", submitLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const title = cleanText(b.title, 150), kebele = cleanText(b.kebele, 100);
    if (!title) return res.status(400).json({ error: "Title is required." });
    if (!kebele || !(await kebeleExists(kebele))) return res.status(400).json({ error: "Choose a Kebele from the list." });
    if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "Choose a valid category." });
    const anonymous = Boolean(b.anonymous);
    const phone = anonymous ? null : (cleanText(b.phone, 20).replace(/\s+/g, "") || null);
    if (phone && !/^(?:\+251|0)[79]\d{8}$/.test(phone)) return res.status(400).json({ error: "Phone must look like 09XXXXXXXX." });
    const email = anonymous ? null : (cleanText(b.email, 254).toLowerCase() || null);
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "Email address is not valid." });

    // Optional photos: up to 3 JPEGs (the page shrinks them first), checked again here.
    const photos = [];
    const prefix = "data:image/jpeg;base64,";
    for (const ph of (Array.isArray(b.photos) ? b.photos.slice(0, 3) : [])) {
      if (typeof ph !== "string" || !ph.startsWith(prefix) || ph.length > 400000)
        return res.status(400).json({ error: "Photos must be JPEG images under 250 KB each." });
      const buf = Buffer.from(ph.slice(prefix.length), "base64");
      if (buf.length < 100 || buf.length > 250 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff)
        return res.status(400).json({ error: "One of the photos is not a valid JPEG image." });
      photos.push(buf);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const client = await pool.connect();
      try {
        const id = crypto.randomUUID(), no = newTrackingNo();
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO citizen_reports (id,tracking_no,category,kebele,location_detail,title,description,phone,email,priority)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, no, b.category, kebele, cleanText(b.locationDetail, 200), title, cleanText(b.description, 3000), phone, email,
           b.priority === "Urgent" ? "Urgent" : "Normal"]);
        await client.query("INSERT INTO report_updates (report_id,status,note) VALUES ($1,'Submitted','Report submitted')", [id]);
        for (const buf of photos)
          await client.query("INSERT INTO report_photos (report_id, mime, data) VALUES ($1,'image/jpeg',$2)", [id, buf]);
        await client.query("COMMIT");
        return res.status(201).json({ trackingNo: no });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        if (err.code !== "23505") throw err; // tracking number collision: retry
      } finally { client.release(); }
    }
    res.status(500).json({ error: "Could not create a tracking number. Try again." });
  }));

  // ---- public: track by number (no phone, no email, no internal notes) ----
  app.get("/api/citizen-reports/track/:no", trackLimiter, wrap(async (req, res) => {
    const r = (await pool.query(
      `SELECT id, tracking_no, category, kebele, title, priority, status, created_at, updated_at, resolved_at
       FROM citizen_reports WHERE tracking_no = $1`, [String(req.params.no).toUpperCase().slice(0, 30)])).rows[0];
    if (!r) return res.status(404).json({ error: "Not found." });
    const updates = (await pool.query(
      "SELECT status, note, created_at FROM report_updates WHERE report_id=$1 AND is_public=true ORDER BY id", [r.id])).rows;
    delete r.id;
    res.json({ report: { ...r, updates } });
  }));

  // ---- staff: inbox with search, filters and pagination ----
  // Query: page, limit (1-100), q, status, category, priority, kebele (admin/sector head),
  //        assigned (me | unassigned | email), overdue=1, from, to (YYYY-MM-DD), sort (urgent | newest | oldest | due)
  app.get("/api/citizen-reports", requireAuth, requireViewer, wrap(async (req, res) => {
    const params = [];
    const where = [scope(req.user, params)];
    const Q = req.query;

    const k = cleanText(Q.kebele, 100);
    if (req.user.role !== "kebele_officer" && k && k !== "All") { params.push(k); where.push(`kebele = $${params.length}`); }
    if (STATUSES.includes(Q.status)) { params.push(Q.status); where.push(`status = $${params.length}`); }
    if (CATEGORIES.includes(Q.category)) { params.push(Q.category); where.push(`category = $${params.length}`); }
    if (["Normal", "Urgent"].includes(Q.priority)) { params.push(Q.priority); where.push(`priority = $${params.length}`); }

    const q = cleanText(Q.q, 100);
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
      const n = params.length;
      where.push(`(title ILIKE $${n} OR description ILIKE $${n} OR tracking_no ILIKE $${n} OR location_detail ILIKE $${n})`);
    }

    const asg = cleanText(Q.assigned, 254).toLowerCase();
    if (asg === "me") { params.push(req.user.email); where.push(`assigned_to = $${params.length}`); }
    else if (asg === "unassigned") where.push("assigned_to = ''");
    else if (asg && EMAIL_RE.test(asg)) { params.push(asg); where.push(`assigned_to = $${params.length}`); }

    if (Q.overdue === "1" || Q.overdue === "true")
      where.push(`due_date < CURRENT_DATE AND status NOT IN ('Resolved','Rejected')`);

    const from = toDay(Q.from), to = toDay(Q.to);
    if (from === undefined || to === undefined) return res.status(400).json({ error: "Dates must look like YYYY-MM-DD." });
    if (from) { params.push(from); where.push(`created_at >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`created_at < ($${params.length}::date + 1)`); }

    const ORDER = {
      urgent: "(priority='Urgent' AND status NOT IN ('Resolved','Rejected')) DESC, created_at DESC",
      newest: "created_at DESC",
      oldest: "created_at ASC",
      due: "due_date ASC NULLS LAST, created_at DESC"
    };
    const orderBy = ORDER[Q.sort] || ORDER.urgent;

    const limit = intParam(Q.limit, 25, 1, 100);
    const page = intParam(Q.page, 1, 1, 100000);
    const whereSql = where.join(" AND ");

    const total = (await pool.query(`SELECT COUNT(*)::int n FROM citizen_reports WHERE ${whereSql}`, params)).rows[0].n;
    const pages = Math.max(1, Math.ceil(total / limit));

    const listParams = [...params, limit, (page - 1) * limit];
    const { rows } = await pool.query(
      `SELECT id, tracking_no, category, kebele, location_detail, title, description, phone, email, priority, status,
              assigned_dept, assigned_to, due_date, resolved_at, created_at, updated_at,
              (due_date IS NOT NULL AND due_date < CURRENT_DATE AND status NOT IN ('Resolved','Rejected')) AS overdue,
              (SELECT COALESCE(array_agg(p.id ORDER BY p.id), '{}'::int[]) FROM report_photos p
                 WHERE p.report_id = citizen_reports.id) AS photo_ids
       FROM citizen_reports WHERE ${whereSql}
       ORDER BY ${orderBy}
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams);

    // Sector heads are read-only and do not see citizens' contact details.
    const readOnly = req.user.role === "sector_head";
    if (readOnly) rows.forEach(r => { r.phone = null; r.email = null; });
    res.json({ reports: rows, page, limit, total, pages, readOnly });
  }));

  // ---- staff: one report with its full history (including internal notes) ----
  app.get("/api/citizen-reports/:id", requireAuth, requireViewer, wrap(async (req, res) => {
    const params = [req.params.id];
    const r = (await pool.query(`SELECT * FROM citizen_reports WHERE id=$1 AND ${scope(req.user, params)}`, params)).rows[0];
    if (!r) return res.status(404).json({ error: "Report not found." });
    const updates = (await pool.query(
      "SELECT status, note, is_public, by_email, created_at FROM report_updates WHERE report_id=$1 ORDER BY id", [r.id])).rows;
    const photos = (await pool.query("SELECT id FROM report_photos WHERE report_id=$1 ORDER BY id", [r.id])).rows.map(p => p.id);
    if (req.user.role === "sector_head") { r.phone = null; r.email = null; }
    res.json({ report: { ...r, photo_ids: photos, updates } });
  }));

  // ---- staff: update status, assignment, due date ----
  app.patch("/api/citizen-reports/:id", requireAuth, requireStaff, wrap(async (req, res) => {
    const params = [req.params.id];
    const cur = (await pool.query(`SELECT * FROM citizen_reports WHERE id=$1 AND ${scope(req.user, params)}`, params)).rows[0];
    if (!cur) return res.status(404).json({ error: "Report not found." });
    const b = req.body || {};

    const status = b.status === undefined ? cur.status : b.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status." });
    const note = cleanText(b.note, 1000);
    if (status === "Rejected" && !note) return res.status(400).json({ error: "A reason is required to reject a report." });
    if (status === "On hold" && status !== cur.status && !note) return res.status(400).json({ error: "Say why the report is on hold." });
    const dept = b.assignedDept === undefined ? cur.assigned_dept : cleanText(b.assignedDept, 80);

    // Assignment: admin can assign any staff email; a kebele officer can assign only to themselves (or clear it).
    let assignedTo = cur.assigned_to;
    if (b.assignedTo !== undefined) {
      const want = cleanText(b.assignedTo, 254).toLowerCase();
      if (want && !EMAIL_RE.test(want)) return res.status(400).json({ error: "Assignee must be an email address." });
      if (want && req.user.role !== "admin" && want !== String(req.user.email).toLowerCase())
        return res.status(403).json({ error: "You can assign reports only to yourself." });
      assignedTo = want;
    }

    // Due date: YYYY-MM-DD or empty to clear.
    let dueDate = cur.due_date;
    if (b.dueDate !== undefined) {
      const d = toDay(b.dueDate);
      if (d === undefined) return res.status(400).json({ error: "Due date must look like YYYY-MM-DD." });
      dueDate = d;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE citizen_reports
            SET status=$2, assigned_dept=$3, assigned_to=$4, due_date=$5::date,
                resolved_at = CASE WHEN $2 = 'Resolved' THEN COALESCE(resolved_at, now()) ELSE NULL END,
                updated_at=now()
          WHERE id=$1`,
        [cur.id, status, dept, assignedTo, dueDate]);
      if (note || status !== cur.status)
        await client.query("INSERT INTO report_updates (report_id,status,note,is_public,by_email) VALUES ($1,$2,$3,$4,$5)",
          [cur.id, status, note, b.public !== false, req.user.email]);
      if (assignedTo !== cur.assigned_to)
        await client.query("INSERT INTO report_updates (report_id,status,note,is_public,by_email) VALUES ($1,$2,$3,false,$4)",
          [cur.id, status, assignedTo ? `Assigned to ${assignedTo}` : "Assignment cleared", req.user.email]);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK").catch(() => {}); throw err; } finally { client.release(); }
    res.json({ ok: true });
  }));

  app.get("/api/citizen-reports-stats", requireAuth, requireViewer, wrap(async (req, res) => {
    const p1 = [], w = scope(req.user, p1);
    const tot = (await pool.query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status NOT IN ('Resolved','Rejected'))::int open,
              COUNT(*) FILTER (WHERE status='Resolved')::int resolved,
              COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('Resolved','Rejected'))::int overdue,
              COUNT(*) FILTER (WHERE assigned_to = '' AND status NOT IN ('Resolved','Rejected'))::int unassigned
       FROM citizen_reports WHERE ${w}`, p1)).rows[0];
    const p2 = [], w2 = scope(req.user, p2, "r.kebele");
    const avg = (await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (u.t - r.created_at)) / 86400) d
       FROM citizen_reports r
       JOIN LATERAL (SELECT MIN(created_at) t FROM report_updates WHERE report_id = r.id AND status='Resolved') u ON u.t IS NOT NULL
       WHERE r.status='Resolved' AND ${w2}`, p2)).rows[0].d;
    const p3 = [], w3 = scope(req.user, p3);
    const perKebele = (await pool.query(
      `SELECT kebele, COUNT(*)::int received, COUNT(*) FILTER (WHERE status='Resolved')::int resolved
       FROM citizen_reports WHERE ${w3} GROUP BY kebele ORDER BY kebele`, p3)).rows;
    const p4 = [], w4 = scope(req.user, p4);
    const byStatus = (await pool.query(
      `SELECT status, COUNT(*)::int n FROM citizen_reports WHERE ${w4} GROUP BY status`, p4)).rows;
    const p5 = [], w5 = scope(req.user, p5);
    const byCategory = (await pool.query(
      `SELECT category, COUNT(*)::int n FROM citizen_reports WHERE ${w5} GROUP BY category ORDER BY n DESC`, p5)).rows;
    res.json({ ...tot, avgResolutionDays: avg == null ? null : Number(Number(avg).toFixed(1)), perKebele, byStatus, byCategory });
  }));

  // ---- announcements ----
  // Public read: the audiences the visitor follows (sent as "A|B|C") plus all Emergency items.
  app.get("/api/announcements", wrap(async (req, res) => {
    const aud = String(req.query.audiences || WHOLE).split("|").map(s => s.trim().slice(0, 100)).filter(Boolean).slice(0, 30);
    if (!aud.includes(WHOLE)) aud.push(WHOLE); // everyone always sees Woreda-wide items
    // Following any kebele also shows "All Kebeles" items; following any sector also shows "All Sectors" items.
    const [kebs, secs] = await Promise.all([
      pool.query("SELECT name FROM kebeles WHERE name = ANY($1::text[])", [aud]),
      pool.query("SELECT name FROM sectors WHERE name = ANY($1::text[])", [aud])
    ]);
    if (kebs.rowCount) aud.push(ALL_KEBELES);
    if (secs.rowCount) aud.push(ALL_SECTORS);
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
    } else if (![WHOLE, ALL_KEBELES, ALL_SECTORS].includes(audience) && !(await kebeleExists(audience)) && !(await sectorExists(audience))) {
      return res.status(400).json({ error: "Audience must be Whole Woreda, All Kebeles, All Sectors, a Kebele or a Sector from the list." });
    }
    // Reject bad dates instead of silently publishing now / never expiring.
    const publishAt = toDate(b.publishAt), expiresAt = toDate(b.expiresAt);
    if (publishAt === undefined) return res.status(400).json({ error: "Publish date is not valid." });
    if (expiresAt === undefined) return res.status(400).json({ error: "Expiry date is not valid." });
    if (expiresAt && Date.parse(expiresAt) <= (publishAt ? Date.parse(publishAt) : Date.now()))
      return res.status(400).json({ error: "Expiry must be after the publish time." });
    const { rows } = await pool.query(
      `INSERT INTO announcements (title_am,title_en,body_am,body_en,type,audience,publish_at,expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8::timestamptz,$9) RETURNING id`,
      [cleanText(b.titleAm, 150), titleEn, cleanText(b.bodyAm, 3000), cleanText(b.bodyEn, 3000), type, audience,
       publishAt, expiresAt, req.user.email]);
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

  // ---- staff: view a report photo (same scope as the inbox) ----
  app.get("/api/citizen-report-photos/:id", requireAuth, requireViewer, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
    const r = (await pool.query(
      `SELECT p.data, c.kebele FROM report_photos p JOIN citizen_reports c ON c.id = p.report_id WHERE p.id = $1`, [id])).rows[0];
    if (!r || (req.user.role === "kebele_officer" && r.kebele !== req.user.kebele)) return res.status(404).json({ error: "Not found." });
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    res.send(r.data);
  }));

  // ================= Periodic (monthly / quarterly) reports to Woreda administration =================
  // Kebele officers: Monthly. Sector heads: Monthly or Quarterly. Administrator reviews.
  const PERIOD_TYPES = ["Monthly", "Quarterly"];
  const periodOk = (type, label) =>
    type === "Monthly" ? /^\d{4}-(0[1-9]|1[0-2])$/.test(label)
    : type === "Quarterly" ? /^\d{4}-Q[1-4]$/.test(label) : false;
  const PR_COLS = `id, unit_type, unit_name, period_type, period_label, summary, achievements, challenges,
    next_plan, status, feedback, submitted_by, submitted_name, reviewed_by, reviewed_at, created_at, updated_at`;

  function myUnit(user) {
    if (user.role === "kebele_officer" && user.kebele) return { type: "kebele", name: user.kebele, allowed: ["Monthly"] };
    if (user.role === "sector_head" && user.sector) return { type: "sector", name: user.sector, allowed: ["Monthly", "Quarterly"] };
    return null;
  }
  const adminOnly = (req, res, next) =>
    req.user.role === "admin" ? next() : res.status(403).json({ error: "Administrator access required." });

  app.get("/api/periodic-reports", requireAuth, wrap(async (req, res) => {
    const where = [], params = [];
    let unit = null;
    if (req.user.role === "admin") {
      for (const [q, col] of [["periodType", "period_type"], ["period", "period_label"], ["status", "status"], ["unitType", "unit_type"]]) {
        const v = cleanText(req.query[q], 40);
        if (v) { params.push(v); where.push(`${col} = $${params.length}`); }
      }
    } else {
      unit = myUnit(req.user);
      if (!unit) return res.json({ reports: [], unit: null });
      params.push(unit.type, unit.name);
      where.push("unit_type = $1 AND unit_name = $2");
    }
    const { rows } = await pool.query(
      `SELECT ${PR_COLS} FROM periodic_reports ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY period_label DESC, unit_name LIMIT 500`, params);
    res.json({ reports: rows, unit });
  }));

  // Public (no login): only reports the administrator has marked "Reviewed", and only
  // the summary and achievements. Challenges, plans, feedback and staff emails stay private.
  app.get("/api/public/periodic-reports", wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT unit_type, unit_name, period_type, period_label, summary, achievements
       FROM periodic_reports WHERE status = 'Reviewed'
       ORDER BY period_label DESC, unit_name LIMIT 100`);
    res.json({ reports: rows });
  }));

  app.post("/api/periodic-reports", requireAuth, wrap(async (req, res) => {
    const u = myUnit(req.user);
    if (!u) return res.status(403).json({ error: "Only kebele officers and sector heads with an assigned kebele or sector submit these reports." });
    const b = req.body || {};
    const periodType = cleanText(b.periodType, 20), label = cleanText(b.period, 10);
    if (!u.allowed.includes(periodType)) return res.status(400).json({ error: `Your role submits: ${u.allowed.join(" or ")} reports.` });
    if (!periodOk(periodType, label)) return res.status(400).json({ error: "Choose a valid period." });
    const summary = cleanText(b.summary, 4000);
    if (!summary) return res.status(400).json({ error: "Summary is required." });
    try {
      const { rows } = await pool.query(
        `INSERT INTO periodic_reports (id, unit_type, unit_name, period_type, period_label, summary, achievements,
           challenges, next_plan, submitted_by, submitted_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${PR_COLS}`,
        [crypto.randomUUID(), u.type, u.name, periodType, label, summary, cleanText(b.achievements, 4000),
         cleanText(b.challenges, 4000), cleanText(b.nextPlan, 4000), req.user.email, req.user.name || ""]);
      res.status(201).json({ report: rows[0] });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "A report for this period already exists. Edit it instead." });
      throw err;
    }
  }));

  app.put("/api/periodic-reports/:id", requireAuth, wrap(async (req, res) => {
    const u = myUnit(req.user);
    if (!u) return res.status(403).json({ error: "Not allowed." });
    const cur = (await pool.query("SELECT status FROM periodic_reports WHERE id=$1 AND unit_type=$2 AND unit_name=$3",
      [req.params.id, u.type, u.name])).rows[0];
    if (!cur) return res.status(404).json({ error: "Report not found." });
    if (cur.status === "Reviewed") return res.status(409).json({ error: "This report was already approved and cannot be edited." });
    const b = req.body || {};
    const summary = cleanText(b.summary, 4000);
    if (!summary) return res.status(400).json({ error: "Summary is required." });
    // The status check is repeated in the UPDATE so a review that lands between the two queries is not overwritten.
    const { rows } = await pool.query(
      `UPDATE periodic_reports SET summary=$2, achievements=$3, challenges=$4, next_plan=$5,
         status='Submitted', submitted_by=$6, submitted_name=$7, updated_at=now()
       WHERE id=$1 AND status <> 'Reviewed' RETURNING ${PR_COLS}`,
      [req.params.id, summary, cleanText(b.achievements, 4000), cleanText(b.challenges, 4000),
       cleanText(b.nextPlan, 4000), req.user.email, req.user.name || ""]);
    if (!rows.length) return res.status(409).json({ error: "This report was already approved and cannot be edited." });
    res.json({ report: rows[0] });
  }));

  app.patch("/api/periodic-reports/:id/review", requireAuth, adminOnly, wrap(async (req, res) => {
    const status = req.body && req.body.status;
    if (!["Reviewed", "Returned"].includes(status)) return res.status(400).json({ error: "Status must be Reviewed or Returned." });
    const feedback = cleanText(req.body.feedback, 2000);
    if (status === "Returned" && !feedback) return res.status(400).json({ error: "Write what needs to be corrected." });
    const { rows } = await pool.query(
      `UPDATE periodic_reports SET status=$2, feedback=$3, reviewed_by=$4, reviewed_at=now(), updated_at=now()
       WHERE id=$1 RETURNING ${PR_COLS}`, [req.params.id, status, feedback, req.user.email]);
    if (!rows.length) return res.status(404).json({ error: "Report not found." });
    res.json({ report: rows[0] });
  }));

  // Administrator: who has submitted for a period and who is missing.
  app.get("/api/periodic-reports-status", requireAuth, adminOnly, wrap(async (req, res) => {
    const type = cleanText(req.query.periodType, 20), label = cleanText(req.query.period, 10);
    if (!PERIOD_TYPES.includes(type) || !periodOk(type, label)) return res.status(400).json({ error: "Choose a valid period." });
    const subs = (await pool.query(
      "SELECT id, unit_type, unit_name, status FROM periodic_reports WHERE period_type=$1 AND period_label=$2", [type, label])).rows;
    // A sector's quarterly report also covers each month of that quarter.
    let qSubs = [];
    if (type === "Monthly") {
      const [y, m] = label.split("-");
      qSubs = (await pool.query(
        "SELECT id, unit_name, status FROM periodic_reports WHERE period_type='Quarterly' AND unit_type='sector' AND period_label=$1",
        [`${y}-Q${Math.ceil(Number(m) / 3)}`])).rows;
    }
    const kebeles = type === "Monthly" ? (await pool.query("SELECT name FROM kebeles WHERE active = true ORDER BY name")).rows : [];
    const sectors = (await pool.query("SELECT name FROM sectors WHERE active = true ORDER BY name")).rows;
    const units = [
      ...kebeles.map(k => ({ unitType: "kebele", unitName: k.name })),
      ...sectors.map(s => ({ unitType: "sector", unitName: s.name }))
    ].map(x => {
      let hit = subs.find(s => s.unit_type === x.unitType && s.unit_name === x.unitName);
      let via = null;
      if (!hit && x.unitType === "sector") { hit = qSubs.find(s => s.unit_name === x.unitName); if (hit) via = "Quarterly"; }
      return { ...x, submitted: !!hit, status: hit ? hit.status : null, id: hit ? hit.id : null, via };
    });
    res.json({ units, submitted: units.filter(u => u.submitted).length, total: units.length });
  }));

}

module.exports = { initTables, mount, WHOLE, STATUSES, CATEGORIES, TYPES };
