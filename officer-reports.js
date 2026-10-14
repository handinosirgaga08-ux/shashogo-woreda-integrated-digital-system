// officer-reports.js — sector officer work reports, sector head review and feedback.
// Uses your existing login, roles and sectors from server.js (no new auth).
//
// Who can do what
//   sector_officer : submit reports, see only their own, reply to feedback, resubmit returned ones
//   sector_head    : see reports of their own sector, give feedback, approve or return
//   admin          : sees everything, can give feedback and decide
//   kebele_officer : no access

const crypto = require("crypto");

async function initTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS officer_reports (
      id TEXT PRIMARY KEY,
      officer_email TEXT NOT NULL,
      officer_name TEXT NOT NULL DEFAULT '',
      sector TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Returned')),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS officer_report_feedback (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES officer_reports(id) ON DELETE CASCADE,
      author_email TEXT NOT NULL,
      author_name TEXT NOT NULL DEFAULT '',
      author_role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS officer_reports_sector_idx ON officer_reports (sector);
    CREATE INDEX IF NOT EXISTS officer_report_feedback_report_idx ON officer_report_feedback (report_id);
  `);
}

function mount(app, { pool, wrap, requireAuth, cleanText }) {
  const isOfficer = u => u.role === "sector_officer";
  const isHead = u => u.role === "sector_head" || u.role === "admin";

  // Rows this user may see. Unknown roles (e.g. kebele_officer) see nothing.
  function visible(user, params) {
    if (user.role === "admin") return "TRUE";
    if (user.role === "sector_head") { params.push(user.sector); return `sector = $${params.length}`; }
    if (user.role === "sector_officer") { params.push(user.email); return `officer_email = $${params.length}`; }
    return "FALSE";
  }

  const requireReportAccess = (req, res, next) =>
    isOfficer(req.user) || isHead(req.user)
      ? next()
      : res.status(403).json({ error: "Not available for your role." });

  const view = (r, feedback) => ({
    id: r.id, officerName: r.officer_name, officerEmail: r.officer_email, sector: r.sector,
    title: r.title, period: r.period, details: r.details, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
    feedback: feedback.filter(f => f.report_id === r.id).map(f => ({
      id: f.id, by: f.author_name || f.author_email, role: f.author_role, text: f.text, createdAt: f.created_at
    }))
  });

  async function withFeedback(rows) {
    if (!rows.length) return [];
    const fb = await pool.query(
      "SELECT * FROM officer_report_feedback WHERE report_id = ANY($1) ORDER BY created_at",
      [rows.map(r => r.id)]
    );
    return rows.map(r => view(r, fb.rows));
  }

  async function getReport(user, id) {
    const params = [id];
    const { rows } = await pool.query(
      `SELECT * FROM officer_reports WHERE id = $1 AND ${visible(user, params)}`, params
    );
    return rows[0] || null;
  }

  async function addFeedback(report, user, text) {
    await pool.query(
      `INSERT INTO officer_report_feedback (id, report_id, author_email, author_name, author_role, text)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), report.id, user.email, user.name || "", isOfficer(user) ? "officer" : "head", text]
    );
  }

  // List (officer: own, head: their sector, admin: all)
  app.get("/api/officer-reports", requireAuth, requireReportAccess, wrap(async (req, res) => {
    const params = [];
    const { rows } = await pool.query(
      `SELECT * FROM officer_reports WHERE ${visible(req.user, params)}
       ORDER BY CASE status WHEN 'Pending' THEN 0 WHEN 'Returned' THEN 1 ELSE 2 END, updated_at DESC`,
      params
    );
    res.json({ reports: await withFeedback(rows) });
  }));

  // Officer submits a report
  app.post("/api/officer-reports", requireAuth, wrap(async (req, res) => {
    if (!isOfficer(req.user)) return res.status(403).json({ error: "Only sector officers can submit reports." });
    if (!req.user.sector) return res.status(400).json({ error: "Your account has no sector assigned. Ask the administrator." });
    const title = cleanText(req.body.title, 150);
    const period = cleanText(req.body.period, 40);
    const details = cleanText(req.body.details, 5000);
    if (!title || !period || !details) return res.status(400).json({ error: "Title, period and details are required." });

    const { rows } = await pool.query(
      `INSERT INTO officer_reports (id, officer_email, officer_name, sector, title, period, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [crypto.randomUUID(), req.user.email, req.user.name || "", req.user.sector, title, period, details]
    );
    res.status(201).json({ report: (await withFeedback(rows))[0] });
  }));

  // Feedback from either side (officer only on their own reports)
  app.post("/api/officer-reports/:id/feedback", requireAuth, requireReportAccess, wrap(async (req, res) => {
    const text = cleanText(req.body.text, 2000);
    if (!text) return res.status(400).json({ error: "Write some feedback first." });
    const report = await getReport(req.user, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found." });
    await addFeedback(report, req.user, text);
    res.status(201).json({ report: (await withFeedback([report]))[0] });
  }));

  // Head approves or returns (returning needs a reason)
  app.post("/api/officer-reports/:id/decision", requireAuth, wrap(async (req, res) => {
    if (!isHead(req.user)) return res.status(403).json({ error: "Only a sector head can approve or return reports." });
    const status = cleanText(req.body.status, 10);
    const text = cleanText(req.body.text, 2000);
    if (!["Approved", "Returned"].includes(status)) return res.status(400).json({ error: "Status must be Approved or Returned." });
    if (status === "Returned" && !text) return res.status(400).json({ error: "Explain what the officer should revise." });
    const report = await getReport(req.user, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found." });

    if (text) await addFeedback(report, req.user, text);
    const { rows } = await pool.query(
      "UPDATE officer_reports SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [report.id, status]
    );
    res.json({ report: (await withFeedback(rows))[0] });
  }));

  // Officer sends a returned report back for review
  app.post("/api/officer-reports/:id/resubmit", requireAuth, wrap(async (req, res) => {
    if (!isOfficer(req.user)) return res.status(403).json({ error: "Only the officer can resubmit." });
    const report = await getReport(req.user, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found." });
    if (report.status !== "Returned") return res.status(400).json({ error: "Only returned reports can be resubmitted." });
    const { rows } = await pool.query(
      "UPDATE officer_reports SET status = 'Pending', updated_at = now() WHERE id = $1 RETURNING *", [report.id]
    );
    res.json({ report: (await withFeedback(rows))[0] });
  }));
}

module.exports = { initTables, mount };
