// Shashogo Woreda workflow API (Express + PostgreSQL)
// Plug into your existing Node app, or run alone for the pilot.
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------- Auth ----------
// Expects a JWT like { id: 12, role: 'citizen' | 'officer' | 'head' | 'admin', kebele: 'Kebele 01' }.
// If your app already issues tokens, use the same secret. Otherwise adapt this.
function auth(roles = []) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      req.user = jwt.verify(token, process.env.JWT_SECRET);
      if (roles.length && !roles.includes(req.user.role))
        return res.status(403).json({ error: 'Not allowed' });
      next();
    } catch {
      res.status(401).json({ error: 'Login required' });
    }
  };
}

// ---------- Allowed status changes (who may do what) ----------
const TRANSITIONS = {
  submitted:  { in_review: ['officer', 'head', 'admin'], cancelled: ['citizen'] },
  in_review:  { needs_info: ['officer', 'head', 'admin'],
                approved:   ['officer', 'head', 'admin'],
                rejected:   ['officer', 'head', 'admin'] },
  needs_info: { in_review: ['citizen', 'officer'], cancelled: ['citizen'] },
  approved:   { issued: ['officer', 'head', 'admin'] },
};

// ---------- Services (public) ----------
app.get('/api/services', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.code, s.name_en, s.name_am, s.fee_etb, s.sla_days,
            COALESCE(json_agg(json_build_object('name', d.doc_name, 'required', d.is_required))
                     FILTER (WHERE d.id IS NOT NULL), '[]') AS documents
     FROM services s LEFT JOIN service_documents d ON d.service_id = s.id
     WHERE s.is_active GROUP BY s.id ORDER BY s.name_en`);
  res.json(rows);
});

// ---------- Citizen: apply ----------
app.post('/api/applications', auth(['citizen']), async (req, res) => {
  const { service_id, form_data = {}, files = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const svc = await client.query(
      'SELECT sla_days FROM services WHERE id=$1 AND is_active', [service_id]);
    if (!svc.rowCount) throw new Error('Unknown service');

    const seq = await client.query("SELECT nextval('application_seq') n");
    const tracking = `SHW-${new Date().getFullYear()}-${String(seq.rows[0].n).padStart(6, '0')}`;

    const ins = await client.query(
      `INSERT INTO applications (tracking_no, service_id, citizen_id, kebele, form_data, due_at)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval) RETURNING id`,
      [tracking, service_id, req.user.id, req.user.kebele || null,
       form_data, svc.rows[0].sla_days]);
    const appId = ins.rows[0].id;

    for (const f of files)
      await client.query(
        'INSERT INTO application_files (application_id, doc_name, file_path) VALUES ($1,$2,$3)',
        [appId, f.doc_name, f.file_path]);

    await client.query(
      `INSERT INTO case_history (application_id, actor_id, actor_role, to_status, note)
       VALUES ($1,$2,'citizen','submitted','Application submitted')`, [appId, req.user.id]);

    await client.query('COMMIT');
    res.status(201).json({ id: appId, tracking_no: tracking });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ---------- Citizen: my applications ----------
app.get('/api/my/applications', auth(['citizen']), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.tracking_no, s.name_en AS service, a.status, a.submitted_at, a.due_at
     FROM applications a JOIN services s ON s.id=a.service_id
     WHERE a.citizen_id=$1 ORDER BY a.submitted_at DESC`, [req.user.id]);
  res.json(rows);
});

// ---------- Track one application (citizen owner or staff) ----------
app.get('/api/applications/:tracking', auth(), async (req, res) => {
  const a = await pool.query(
    `SELECT a.*, s.name_en AS service FROM applications a
     JOIN services s ON s.id=a.service_id WHERE a.tracking_no=$1`, [req.params.tracking]);
  if (!a.rowCount) return res.status(404).json({ error: 'Not found' });
  const app_ = a.rows[0];
  if (req.user.role === 'citizen' && String(app_.citizen_id) !== String(req.user.id))
    return res.status(403).json({ error: 'Not allowed' });
  const h = await pool.query(
    `SELECT from_status, to_status, note, actor_role, created_at
     FROM case_history WHERE application_id=$1 ORDER BY created_at`, [app_.id]);
  res.json({ ...app_, history: h.rows });
});

// ---------- Officer: inbox ----------
// ?status=submitted&overdue=true&kebele=Kebele%2001
app.get('/api/inbox', auth(['officer', 'head', 'admin']), async (req, res) => {
  const { status, overdue, kebele } = req.query;
  const where = ["a.status NOT IN ('issued','rejected','cancelled')"];
  const p = [];
  if (status)  { p.push(status);  where.push(`a.status = $${p.length}`); }
  if (kebele)  { p.push(kebele);  where.push(`a.kebele = $${p.length}`); }
  if (overdue === 'true') where.push('a.due_at < now()');
  const { rows } = await pool.query(
    `SELECT a.id, a.tracking_no, s.name_en AS service, a.status, a.kebele,
            a.assigned_to, a.due_at, (a.due_at < now()) AS is_overdue
     FROM applications a JOIN services s ON s.id=a.service_id
     WHERE ${where.join(' AND ')} ORDER BY a.due_at ASC LIMIT 200`, p);
  res.json(rows);
});

// ---------- Move a case to the next status ----------
// body: { to_status: 'approved', note: '...' }
app.post('/api/applications/:id/action', auth(), async (req, res) => {
  const { to_status, note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT id, status, citizen_id FROM applications WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rowCount) throw new Error('Not found');
    const a = cur.rows[0];

    if (req.user.role === 'citizen' && String(a.citizen_id) !== String(req.user.id))
      throw new Error('Not your application');

    const allowed = (TRANSITIONS[a.status] || {})[to_status];
    if (!allowed || !allowed.includes(req.user.role))
      throw new Error(`Cannot change ${a.status} to ${to_status}`);
    if (['rejected', 'needs_info'].includes(to_status) && !note)
      throw new Error('A reason is required');

    const closing = ['issued', 'rejected', 'cancelled'].includes(to_status);
    await client.query(
      `UPDATE applications SET status=$1, updated_at=now(),
         assigned_to = CASE WHEN $1='in_review' AND $3 <> 'citizen' THEN $2 ELSE assigned_to END,
         closed_at = CASE WHEN $4 THEN now() ELSE closed_at END
       WHERE id=$5`, [to_status, req.user.id, req.user.role, closing, a.id]);

    await client.query(
      `INSERT INTO case_history (application_id, actor_id, actor_role, from_status, to_status, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.id, req.user.id, req.user.role, a.status, to_status, note || null]);

    await client.query('COMMIT');
    // TODO: send SMS/push to the citizen here (BullMQ job)
    res.json({ ok: true, status: to_status });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ---------- Reports for the dashboard ----------
app.get('/api/reports/summary', auth(['head', 'admin']), async (req, res) => {
  const [byStatus, byService, avgDays] = await Promise.all([
    pool.query(`SELECT status, count(*)::int FROM applications GROUP BY status`),
    pool.query(`SELECT s.name_en AS service, count(*)::int AS total,
                  count(*) FILTER (WHERE a.status NOT IN ('issued','rejected','cancelled')
                                   AND a.due_at < now())::int AS overdue
                FROM applications a JOIN services s ON s.id=a.service_id GROUP BY s.name_en`),
    pool.query(`SELECT s.name_en AS service,
                  round(avg(extract(epoch FROM (a.closed_at - a.submitted_at))/86400)::numeric,1) AS avg_days
                FROM applications a JOIN services s ON s.id=a.service_id
                WHERE a.closed_at IS NOT NULL GROUP BY s.name_en`),
  ]);
  res.json({ by_status: byStatus.rows, by_service: byService.rows, avg_days: avgDays.rows });
});

app.get('/api/reports/officers', auth(['head', 'admin']), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT assigned_to AS officer_id, count(*)::int AS handled,
            count(*) FILTER (WHERE closed_at IS NOT NULL AND closed_at <= due_at)::int AS on_time
     FROM applications WHERE assigned_to IS NOT NULL GROUP BY assigned_to ORDER BY handled DESC`);
  res.json(rows);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Workflow API on :${port}`));
