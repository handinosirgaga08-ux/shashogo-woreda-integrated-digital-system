// Citizen reports + announcements for SWIDS. Plugs into the existing server.js.
const crypto = require(&quot;crypto&quot;);
const rateLimit = require(&quot;express-rate-limit&quot;);

const STATUSES = [&quot;Submitted&quot;, &quot;Received&quot;, &quot;In progress&quot;, &quot;Resolved&quot;, &quot;Rejected&quot;];
const CATEGORIES = [&quot;Service complaint&quot;, &quot;Infrastructure&quot;, &quot;Security&quot;, &quot;Health&quot;, &quot;Agriculture&quot;, &quot;Suggestion&quot;, &quot;Other&quot;];
const TYPES = [&quot;General&quot;, &quot;Emergency&quot;, &quot;Event&quot;, &quot;Service notice&quot;];
const WHOLE = &quot;Whole Woreda&quot;;
const ALL_KEBELES = &quot;All Kebeles&quot;;
const ALL_SECTORS = &quot;All Sectors&quot;;

async function initTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS citizen_reports (
      id TEXT PRIMARY KEY,
      tracking_no TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      kebele TEXT NOT NULL,
      location_detail TEXT DEFAULT &#x27;&#x27;,
      title TEXT NOT NULL,
      description TEXT DEFAULT &#x27;&#x27;,
      phone TEXT,
      priority TEXT NOT NULL DEFAULT &#x27;Normal&#x27;,
      status TEXT NOT NULL DEFAULT &#x27;Submitted&#x27;,
      assigned_dept TEXT DEFAULT &#x27;&#x27;,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_updates (
      id SERIAL PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES citizen_reports(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      note TEXT DEFAULT &#x27;&#x27;,
      is_public BOOLEAN NOT NULL DEFAULT true,
      by_email TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title_am TEXT DEFAULT &#x27;&#x27;,
      title_en TEXT NOT NULL,
      body_am TEXT DEFAULT &#x27;&#x27;,
      body_en TEXT DEFAULT &#x27;&#x27;,
      type TEXT NOT NULL DEFAULT &#x27;General&#x27;,
      audience TEXT NOT NULL DEFAULT &#x27;Whole Woreda&#x27;,
      publish_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cr_kebele_status ON citizen_reports (kebele, status);
    CREATE INDEX IF NOT EXISTS idx_ann_pub ON announcements (publish_at);
    CREATE TABLE IF NOT EXISTS report_photos (
      id SERIAL PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES citizen_reports(id) ON DELETE CASCADE,
      mime TEXT NOT NULL DEFAULT &#x27;image/jpeg&#x27;,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_photos_report ON report_photos (report_id);
    CREATE INDEX IF NOT EXISTS idx_updates_report ON report_updates (report_id);
    CREATE TABLE IF NOT EXISTS periodic_reports (
      id TEXT PRIMARY KEY,
      unit_type TEXT NOT NULL CHECK (unit_type IN (&#x27;kebele&#x27;,&#x27;sector&#x27;)),
      unit_name TEXT NOT NULL,
      period_type TEXT NOT NULL CHECK (period_type IN (&#x27;Monthly&#x27;,&#x27;Quarterly&#x27;)),
      period_label TEXT NOT NULL,
      summary TEXT NOT NULL,
      achievements TEXT DEFAULT &#x27;&#x27;,
      challenges TEXT DEFAULT &#x27;&#x27;,
      next_plan TEXT DEFAULT &#x27;&#x27;,
      status TEXT NOT NULL DEFAULT &#x27;Submitted&#x27;,
      feedback TEXT DEFAULT &#x27;&#x27;,
      submitted_by TEXT NOT NULL,
      submitted_name TEXT DEFAULT &#x27;&#x27;,
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (unit_type, unit_name, period_type, period_label)
    );
  `);
}

// Random, hard-to-guess tracking number (so strangers cannot browse other people&#x27;s reports).
function newTrackingNo() {
  const A = &quot;ABCDEFGHJKLMNPQRSTUVWXYZ23456789&quot;;
  let s = &quot;&quot;;
  for (let i = 0; i &lt; 6; i++) s += A[crypto.randomInt(A.length)];
  return `SW-${new Date().getFullYear()}-${s}`;
}

function mount(app, { pool, wrap, requireAuth, cleanText }) {
  const requireStaff = (req, res, next) =&gt;
    [&quot;admin&quot;, &quot;kebele_officer&quot;].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: &quot;Staff access required.&quot; });

  // admin sees all; kebele officer only their kebele; no kebele assigned = nothing.
  // `col` lets callers qualify the column (e.g. &quot;r.kebele&quot;) when the query uses a table alias.
  function scope(user, params, col = &quot;kebele&quot;) {
    if (user.role === &quot;admin&quot;) return &quot;TRUE&quot;;
    if (!user.kebele) return &quot;FALSE&quot;;
    params.push(user.kebele);
    return `${col} = $${params.length}`;
  }
  // Returns an ISO string, or null for empty input. Returns undefined when the value is present but not a valid date.
  const toDate = v =&gt; {
    if (v === undefined || v === null || v === &quot;&quot;) return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  };
  async function sectorExists(name) {
    const total = await pool.query(&quot;SELECT COUNT(*)::int n FROM sectors WHERE active = true&quot;);
    if (total.rows[0].n === 0) return false; // no sectors set up: nothing to match
    return (await pool.query(&quot;SELECT 1 FROM sectors WHERE name=$1 AND active=true&quot;, [name])).rowCount &gt; 0;
  }
  async function kebeleExists(name) {
    const total = await pool.query(&quot;SELECT COUNT(*)::int n FROM kebeles WHERE active = true&quot;);
    if (total.rows[0].n === 0) return true; // list not set up yet
    return (await pool.query(&quot;SELECT 1 FROM kebeles WHERE name=$1 AND active=true&quot;, [name])).rowCount &gt; 0;
  }

  const submitLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: &quot;Too many reports from this connection. Try again later.&quot; } });
  const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
    message: { error: &quot;Too many lookups. Try again later.&quot; } });

  // ---- public: kebele list for dropdowns ----
  app.get(&quot;/api/public/kebeles&quot;, wrap(async (req, res) =&gt; {
    const { rows } = await pool.query(&quot;SELECT name FROM kebeles WHERE active = true ORDER BY name&quot;);
    res.json({ kebeles: rows.map(r =&gt; r.name) });
  }));

  // ---- public: sector list for announcement audiences ----
  app.get(&quot;/api/public/sectors&quot;, wrap(async (req, res) =&gt; {
    const { rows } = await pool.query(&quot;SELECT name FROM sectors WHERE active = true ORDER BY name&quot;);
    res.json({ sectors: rows.map(r =&gt; r.name) });
  }));

  // ---- public: submit a report (no login) ----
  app.post(&quot;/api/citizen-reports&quot;, submitLimiter, wrap(async (req, res) =&gt; {
    const b = req.body || {};
    const title = cleanText(b.title, 150), kebele = cleanText(b.kebele, 100);
    if (!title) return res.status(400).json({ error: &quot;Title is required.&quot; });
    if (!kebele || !(await kebeleExists(kebele))) return res.status(400).json({ error: &quot;Choose a Kebele from the list.&quot; });
    if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: &quot;Choose a valid category.&quot; });
    const anonymous = Boolean(b.anonymous);
    const phone = anonymous ? null : (cleanText(b.phone, 20).replace(/\s+/g, &quot;&quot;) || null);
    if (phone &amp;&amp; !/^(?:\+251|0)[79]\d{8}$/.test(phone)) return res.status(400).json({ error: &quot;Phone must look like 09XXXXXXXX.&quot; });

    // Optional photos: up to 3 JPEGs (the page shrinks them first), checked again here.
    const photos = [];
    const prefix = &quot;data:image/jpeg;base64,&quot;;
    for (const ph of (Array.isArray(b.photos) ? b.photos.slice(0, 3) : [])) {
      if (typeof ph !== &quot;string&quot; || !ph.startsWith(prefix) || ph.length &gt; 400000)
        return res.status(400).json({ error: &quot;Photos must be JPEG images under 250 KB each.&quot; });
      const buf = Buffer.from(ph.slice(prefix.length), &quot;base64&quot;);
      if (buf.length &lt; 100 || buf.length &gt; 250 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff)
        return res.status(400).json({ error: &quot;One of the photos is not a valid JPEG image.&quot; });
      photos.push(buf);
    }

    for (let attempt = 0; attempt &lt; 5; attempt++) {
      const client = await pool.connect();
      try {
        const id = crypto.randomUUID(), no = newTrackingNo();
        await client.query(&quot;BEGIN&quot;);
        await client.query(
          `INSERT INTO citizen_reports (id,tracking_no,category,kebele,location_detail,title,description,phone,priority)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, no, b.category, kebele, cleanText(b.locationDetail, 200), title, cleanText(b.description, 3000), phone,
           b.priority === &quot;Urgent&quot; ? &quot;Urgent&quot; : &quot;Normal&quot;]);
        await client.query(&quot;INSERT INTO report_updates (report_id,status,note) VALUES ($1,&#x27;Submitted&#x27;,&#x27;Report submitted&#x27;)&quot;, [id]);
        for (const buf of photos)
          await client.query(&quot;INSERT INTO report_photos (report_id, mime, data) VALUES ($1,&#x27;image/jpeg&#x27;,$2)&quot;, [id, buf]);
        await client.query(&quot;COMMIT&quot;);
        return res.status(201).json({ trackingNo: no });
      } catch (err) {
        await client.query(&quot;ROLLBACK&quot;).catch(() =&gt; {});
        if (err.code !== &quot;23505&quot;) throw err; // tracking number collision: retry
      } finally { client.release(); }
    }
    res.status(500).json({ error: &quot;Could not create a tracking number. Try again.&quot; });
  }));

  // ---- public: track by number (no phone, no internal notes) ----
  app.get(&quot;/api/citizen-reports/track/:no&quot;, trackLimiter, wrap(async (req, res) =&gt; {
    const r = (await pool.query(
      `SELECT id, tracking_no, category, kebele, title, priority, status, created_at, updated_at
       FROM citizen_reports WHERE tracking_no = $1`, [String(req.params.no).toUpperCase().slice(0, 30)])).rows[0];
    if (!r) return res.status(404).json({ error: &quot;Not found.&quot; });
    const updates = (await pool.query(
      &quot;SELECT status, note, created_at FROM report_updates WHERE report_id=$1 AND is_public=true ORDER BY id&quot;, [r.id])).rows;
    delete r.id;
    res.json({ report: { ...r, updates } });
  }));

  // ---- staff: inbox, update, stats ----
  app.get(&quot;/api/citizen-reports&quot;, requireAuth, requireStaff, wrap(async (req, res) =&gt; {
    const params = [];
    const where = [scope(req.user, params)];
    const k = cleanText(req.query.kebele, 100);
    if (req.user.role === &quot;admin&quot; &amp;&amp; k &amp;&amp; k !== &quot;All&quot;) { params.push(k); where.push(`kebele = $${params.length}`); }
    if (STATUSES.includes(req.query.status)) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (CATEGORIES.includes(req.query.category)) { params.push(req.query.category); where.push(`category = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT id, tracking_no, category, kebele, location_detail, title, description, phone, priority, status,
              assigned_dept, created_at, updated_at,
              (SELECT COALESCE(array_agg(p.id ORDER BY p.id), &#x27;{}&#x27;::int[]) FROM report_photos p
                 WHERE p.report_id = citizen_reports.id) AS photo_ids
       FROM citizen_reports WHERE ${where.join(&quot; AND &quot;)}
       ORDER BY (priority=&#x27;Urgent&#x27; AND status NOT IN (&#x27;Resolved&#x27;,&#x27;Rejected&#x27;)) DESC, created_at DESC LIMIT 200`, params);
    res.json({ reports: rows });
  }));

  app.patch(&quot;/api/citizen-reports/:id&quot;, requireAuth, requireStaff, wrap(async (req, res) =&gt; {
    const params = [req.params.id];
    const cur = (await pool.query(`SELECT * FROM citizen_reports WHERE id=$1 AND ${scope(req.user, params)}`, params)).rows[0];
    if (!cur) return res.status(404).json({ error: &quot;Report not found.&quot; });
    const b = req.body || {};
    const status = b.status === undefined ? cur.status : b.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: &quot;Invalid status.&quot; });
    const note = cleanText(b.note, 1000);
    if (status === &quot;Rejected&quot; &amp;&amp; !note) return res.status(400).json({ error: &quot;A reason is required to reject a report.&quot; });
    const dept = b.assignedDept === undefined ? cur.assigned_dept : cleanText(b.assignedDept, 80);

    const client = await pool.connect();
    try {
      await client.query(&quot;BEGIN&quot;);
      await client.query(&quot;UPDATE citizen_reports SET status=$2, assigned_dept=$3, updated_at=now() WHERE id=$1&quot;, [cur.id, status, dept]);
      if (note || status !== cur.status)
        await client.query(&quot;INSERT INTO report_updates (report_id,status,note,is_public,by_email) VALUES ($1,$2,$3,$4,$5)&quot;,
          [cur.id, status, note, b.public !== false, req.user.email]);
      await client.query(&quot;COMMIT&quot;);
    } catch (err) { await client.query(&quot;ROLLBACK&quot;).catch(() =&gt; {}); throw err; } finally { client.release(); }
    res.json({ ok: true });
  }));

  app.get(&quot;/api/citizen-reports-stats&quot;, requireAuth, requireStaff, wrap(async (req, res) =&gt; {
    const p1 = [], w = scope(req.user, p1);
    const tot = (await pool.query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status NOT IN (&#x27;Resolved&#x27;,&#x27;Rejected&#x27;))::int open,
              COUNT(*) FILTER (WHERE status=&#x27;Resolved&#x27;)::int resolved
       FROM citizen_reports WHERE ${w}`, p1)).rows[0];
    const p2 = [], w2 = scope(req.user, p2, &quot;r.kebele&quot;);
    const avg = (await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (u.t - r.created_at)) / 86400) d
       FROM citizen_reports r
       JOIN LATERAL (SELECT MIN(created_at) t FROM report_updates WHERE report_id = r.id AND status=&#x27;Resolved&#x27;) u ON u.t IS NOT NULL
       WHERE r.status=&#x27;Resolved&#x27; AND ${w2}`, p2)).rows[0].d;
    const p3 = [], w3 = scope(req.user, p3);
    const perKebele = (await pool.query(
      `SELECT kebele, COUNT(*)::int received, COUNT(*) FILTER (WHERE status=&#x27;Resolved&#x27;)::int resolved
       FROM citizen_reports WHERE ${w3} GROUP BY kebele ORDER BY kebele`, p3)).rows;
    res.json({ ...tot, avgResolutionDays: avg == null ? null : Number(Number(avg).toFixed(1)), perKebele });
  }));

  // ---- announcements ----
  // Public read: the audiences the visitor follows (sent as &quot;A|B|C&quot;) plus all Emergency items.
  app.get(&quot;/api/announcements&quot;, wrap(async (req, res) =&gt; {
    const aud = String(req.query.audiences || WHOLE).split(&quot;|&quot;).map(s =&gt; s.trim().slice(0, 100)).filter(Boolean).slice(0, 30);
    if (!aud.includes(WHOLE)) aud.push(WHOLE); // everyone always sees Woreda-wide items
    // Following any kebele also shows &quot;All Kebeles&quot; items; following any sector also shows &quot;All Sectors&quot; items.
    const [kebs, secs] = await Promise.all([
      pool.query(&quot;SELECT name FROM kebeles WHERE name = ANY($1::text[])&quot;, [aud]),
      pool.query(&quot;SELECT name FROM sectors WHERE name = ANY($1::text[])&quot;, [aud])
    ]);
    if (kebs.rowCount) aud.push(ALL_KEBELES);
    if (secs.rowCount) aud.push(ALL_SECTORS);
    const { rows } = await pool.query(
      `SELECT id, title_am, title_en, body_am, body_en, type, audience, publish_at, expires_at
       FROM announcements
       WHERE publish_at &lt;= now() AND (expires_at IS NULL OR expires_at &gt; now())
         AND (audience = ANY($1::text[]) OR type = &#x27;Emergency&#x27;)
       ORDER BY publish_at DESC LIMIT 100`, [aud]);
    res.json({ announcements: rows });
  }));

  app.post(&quot;/api/announcements&quot;, requireAuth, requireStaff, wrap(async (req, res) =&gt; {
    const b = req.body || {};
    const titleEn = cleanText(b.titleEn, 150);
    if (!titleEn) return res.status(400).json({ error: &quot;English title is required.&quot; });
    const type = b.type || &quot;General&quot;;
    if (!TYPES.includes(type)) return res.status(400).json({ error: &quot;Invalid type.&quot; });
    let audience = cleanText(b.audience, 100) || (req.user.role === &quot;admin&quot; ? WHOLE : req.user.kebele);
    if (req.user.role === &quot;kebele_officer&quot;) {
      if (!req.user.kebele) return res.status(400).json({ error: &quot;Your account has no kebele assigned.&quot; });
      if (audience !== req.user.kebele) return res.status(403).json({ error: &quot;You can post only to your own kebele.&quot; });
    } else if (![WHOLE, ALL_KEBELES, ALL_SECTORS].includes(audience) &amp;&amp; !(await kebeleExists(audience)) &amp;&amp; !(await sectorExists(audience))) {
      return res.status(400).json({ error: &quot;Audience must be Whole Woreda, All Kebeles, All Sectors, a Kebele or a Sector from the list.&quot; });
    }
    // Reject bad dates instead of silently publishing now / never expiring.
    const publishAt = toDate(b.publishAt), expiresAt = toDate(b.expiresAt);
    if (publishAt === undefined) return res.status(400).json({ error: &quot;Publish date is not valid.&quot; });
    if (expiresAt === undefined) return res.status(400).json({ error: &quot;Expiry date is not valid.&quot; });
    if (expiresAt &amp;&amp; Date.parse(expiresAt) &lt;= (publishAt ? Date.parse(publishAt) : Date.now()))
      return res.status(400).json({ error: &quot;Expiry must be after the publish time.&quot; });
    const { rows } = await pool.query(
      `INSERT INTO announcements (title_am,title_en,body_am,body_en,type,audience,publish_at,expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8::timestamptz,$9) RETURNING id`,
      [cleanText(b.titleAm, 150), titleEn, cleanText(b.bodyAm, 3000), cleanText(b.bodyEn, 3000), type, audience,
       publishAt, expiresAt, req.user.email]);
    res.status(201).json({ id: rows[0].id });
  }));

  app.delete(&quot;/api/announcements/:id&quot;, requireAuth, requireStaff, wrap(async (req, res) =&gt; {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: &quot;Invalid id.&quot; });
    const params = [id];
    let extra = &quot;&quot;;
    if (req.user.role !== &quot;admin&quot;) { params.push(req.user.kebele || &quot;&quot;); extra = &quot; AND audience = $2&quot;; }
    const { rowCount } = await pool.query(`DELETE FROM announcements WHERE id=$1${extra}`, params);
    if (!rowCount) return res.status(404).json({ error: &quot;Announcement not found.&quot; });
    res.json({ ok: true });
  }));

  // ---- staff: view a report photo (same kebele scope as the inbox) ----
  app.get(&quot;/api/citizen-report-photos/:id&quot;, requireAuth, requireStaff, wrap(async (req, res) =&gt; {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: &quot;Invalid id.&quot; });
    const r = (await pool.query(
      `SELECT p.data, c.kebele FROM report_photos p JOIN citizen_reports c ON c.id = p.report_id WHERE p.id = $1`, [id])).rows[0];
    if (!r || (req.user.role !== &quot;admin&quot; &amp;&amp; r.kebele !== req.user.kebele)) return res.status(404).json({ error: &quot;Not found.&quot; });
    res.set({ &quot;Content-Type&quot;: &quot;image/jpeg&quot;, &quot;Cache-Control&quot;: &quot;private, max-age=3600&quot;, &quot;X-Content-Type-Options&quot;: &quot;nosniff&quot; });
    res.send(r.data);
  }));

  // ================= Periodic (monthly / quarterly) reports to Woreda administration =================
  // Kebele officers: Monthly. Sector heads: Monthly or Quarterly. Administrator reviews.
  const PERIOD_TYPES = [&quot;Monthly&quot;, &quot;Quarterly&quot;];
  const periodOk = (type, label) =&gt;
    type === &quot;Monthly&quot; ? /^\d{4}-(0[1-9]|1[0-2])$/.test(label)
    : type === &quot;Quarterly&quot; ? /^\d{4}-Q[1-4]$/.test(label) : false;
  const PR_COLS = `id, unit_type, unit_name, period_type, period_label, summary, achievements, challenges,
    next_plan, status, feedback, submitted_by, submitted_name, reviewed_by, reviewed_at, created_at, updated_at`;

  function myUnit(user) {
    if (user.role === &quot;kebele_officer&quot; &amp;&amp; user.kebele) return { type: &quot;kebele&quot;, name: user.kebele, allowed: [&quot;Monthly&quot;] };
    if (user.role === &quot;sector_head&quot; &amp;&amp; user.sector) return { type: &quot;sector&quot;, name: user.sector, allowed: [&quot;Monthly&quot;, &quot;Quarterly&quot;] };
    return null;
  }
  const adminOnly = (req, res, next) =&gt;
    req.user.role === &quot;admin&quot; ? next() : res.status(403).json({ error: &quot;Administrator access required.&quot; });

  app.get(&quot;/api/periodic-reports&quot;, requireAuth, wrap(async (req, res) =&gt; {
    const where = [], params = [];
    let unit = null;
    if (req.user.role === &quot;admin&quot;) {
      for (const [q, col] of [[&quot;periodType&quot;, &quot;period_type&quot;], [&quot;period&quot;, &quot;period_label&quot;], [&quot;status&quot;, &quot;status&quot;], [&quot;unitType&quot;, &quot;unit_type&quot;]]) {
        const v = cleanText(req.query[q], 40);
        if (v) { params.push(v); where.push(`${col} = $${params.length}`); }
      }
    } else {
      unit = myUnit(req.user);
      if (!unit) return res.json({ reports: [], unit: null });
      params.push(unit.type, unit.name);
      where.push(&quot;unit_type = $1 AND unit_name = $2&quot;);
    }
    const { rows } = await pool.query(
      `SELECT ${PR_COLS} FROM periodic_reports ${where.length ? &quot;WHERE &quot; + where.join(&quot; AND &quot;) : &quot;&quot;}
       ORDER BY period_label DESC, unit_name LIMIT 500`, params);
    res.json({ reports: rows, unit });
  }));

  app.post(&quot;/api/periodic-reports&quot;, requireAuth, wrap(async (req, res) =&gt; {
    const u = myUnit(req.user);
    if (!u) return res.status(403).json({ error: &quot;Only kebele officers and sector heads with an assigned kebele or sector submit these reports.&quot; });
    const b = req.body || {};
    const periodType = cleanText(b.periodType, 20), label = cleanText(b.period, 10);
    if (!u.allowed.includes(periodType)) return res.status(400).json({ error: `Your role submits: ${u.allowed.join(&quot; or &quot;)} reports.` });
    if (!periodOk(periodType, label)) return res.status(400).json({ error: &quot;Choose a valid period.&quot; });
    const summary = cleanText(b.summary, 4000);
    if (!summary) return res.status(400).json({ error: &quot;Summary is required.&quot; });
    try {
      const { rows } = await pool.query(
        `INSERT INTO periodic_reports (id, unit_type, unit_name, period_type, period_label, summary, achievements,
           challenges, next_plan, submitted_by, submitted_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${PR_COLS}`,
        [crypto.randomUUID(), u.type, u.name, periodType, label, summary, cleanText(b.achievements, 4000),
         cleanText(b.challenges, 4000), cleanText(b.nextPlan, 4000), req.user.email, req.user.name || &quot;&quot;]);
      res.status(201).json({ report: rows[0] });
    } catch (err) {
      if (err.code === &quot;23505&quot;) return res.status(409).json({ error: &quot;A report for this period already exists. Edit it instead.&quot; });
      throw err;
    }
  }));

  app.put(&quot;/api/periodic-reports/:id&quot;, requireAuth, wrap(async (req, res) =&gt; {
    const u = myUnit(req.user);
    if (!u) return res.status(403).json({ error: &quot;Not allowed.&quot; });
    const cur = (await pool.query(&quot;SELECT status FROM periodic_reports WHERE id=$1 AND unit_type=$2 AND unit_name=$3&quot;,
      [req.params.id, u.type, u.name])).rows[0];
    if (!cur) return res.status(404).json({ error: &quot;Report not found.&quot; });
    if (cur.status === &quot;Reviewed&quot;) return res.status(409).json({ error: &quot;This report was already approved and cannot be edited.&quot; });
    const b = req.body || {};
    const summary = cleanText(b.summary, 4000);
    if (!summary) return res.status(400).json({ error: &quot;Summary is required.&quot; });
    // The status check is repeated in the UPDATE so a review that lands between the two queries is not overwritten.
    const { rows } = await pool.query(
      `UPDATE periodic_reports SET summary=$2, achievements=$3, challenges=$4, next_plan=$5,
         status=&#x27;Submitted&#x27;, submitted_by=$6, submitted_name=$7, updated_at=now()
       WHERE id=$1 AND status &lt;&gt; &#x27;Reviewed&#x27; RETURNING ${PR_COLS}`,
      [req.params.id, summary, cleanText(b.achievements, 4000), cleanText(b.challenges, 4000),
       cleanText(b.nextPlan, 4000), req.user.email, req.user.name || &quot;&quot;]);
    if (!rows.length) return res.status(409).json({ error: &quot;This report was already approved and cannot be edited.&quot; });
    res.json({ report: rows[0] });
  }));

  app.patch(&quot;/api/periodic-reports/:id/review&quot;, requireAuth, adminOnly, wrap(async (req, res) =&gt; {
    const status = req.body &amp;&amp; req.body.status;
    if (![&quot;Reviewed&quot;, &quot;Returned&quot;].includes(status)) return res.status(400).json({ error: &quot;Status must be Reviewed or Returned.&quot; });
    const feedback = cleanText(req.body.feedback, 2000);
    if (status === &quot;Returned&quot; &amp;&amp; !feedback) return res.status(400).json({ error: &quot;Write what needs to be corrected.&quot; });
    const { rows } = await pool.query(
      `UPDATE periodic_reports SET status=$2, feedback=$3, reviewed_by=$4, reviewed_at=now(), updated_at=now()
       WHERE id=$1 RETURNING ${PR_COLS}`, [req.params.id, status, feedback, req.user.email]);
    if (!rows.length) return res.status(404).json({ error: &quot;Report not found.&quot; });
    res.json({ report: rows[0] });
  }));

  // Administrator: who has submitted for a period and who is missing.
  app.get(&quot;/api/periodic-reports-status&quot;, requireAuth, adminOnly, wrap(async (req, res) =&gt; {
    const type = cleanText(req.query.periodType, 20), label = cleanText(req.query.period, 10);
    if (!PERIOD_TYPES.includes(type) || !periodOk(type, label)) return res.status(400).json({ error: &quot;Choose a valid period.&quot; });
    const subs = (await pool.query(
      &quot;SELECT id, unit_type, unit_name, status FROM periodic_reports WHERE period_type=$1 AND period_label=$2&quot;, [type, label])).rows;
    // A sector&#x27;s quarterly report also covers each month of that quarter.
    let qSubs = [];
    if (type === &quot;Monthly&quot;) {
      const [y, m] = label.split(&quot;-&quot;);
      qSubs = (await pool.query(
        &quot;SELECT id, unit_name, status FROM periodic_reports WHERE period_type=&#x27;Quarterly&#x27; AND unit_type=&#x27;sector&#x27; AND period_label=$1&quot;,
        [`${y}-Q${Math.ceil(Number(m) / 3)}`])).rows;
    }
    const kebeles = type === &quot;Monthly&quot; ? (await pool.query(&quot;SELECT name FROM kebeles WHERE active = true ORDER BY name&quot;)).rows : [];
    const sectors = (await pool.query(&quot;SELECT name FROM sectors WHERE active = true ORDER BY name&quot;)).rows;
    const units = [
      ...kebeles.map(k =&gt; ({ unitType: &quot;kebele&quot;, unitName: k.name })),
      ...sectors.map(s =&gt; ({ unitType: &quot;sector&quot;, unitName: s.name }))
    ].map(x =&gt; {
      let hit = subs.find(s =&gt; s.unit_type === x.unitType &amp;&amp; s.unit_name === x.unitName);
      let via = null;
      if (!hit &amp;&amp; x.unitType === &quot;sector&quot;) { hit = qSubs.find(s =&gt; s.unit_name === x.unitName); if (hit) via = &quot;Quarterly&quot;; }
      return { ...x, submitted: !!hit, status: hit ? hit.status : null, id: hit ? hit.id : null, via };
    });
    res.json({ units, submitted: units.filter(u =&gt; u.submitted).length, total: units.length });
  }));

}

module.exports = { initTables, mount, WHOLE, STATUSES, CATEGORIES, TYPES };
