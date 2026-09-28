const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 5000);

// Old JSON files: only used for a one-time import into PostgreSQL.
const DATA_FILE = path.resolve(process.env.DATA_FILE || "./data/records.json");
const EVAL_FILE = path.resolve(process.env.EVAL_FILE || "./data/evaluations.json");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-this-secret";
const DATABASE_URL = process.env.DATABASE_URL;

if (process.env.NODE_ENV === "production" && SESSION_SECRET === "dev-only-change-this-secret") {
  throw new Error("SESSION_SECRET must be changed in production.");
}
if (process.env.NODE_ENV === "production" && ADMIN_PASSWORD === "change-me") {
  throw new Error("ADMIN_PASSWORD must be changed in production.");
}
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required (PostgreSQL connection string).");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|@dpg-[a-z0-9]+-a[:\/]/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

// ---------------- Session (signed cookie) ----------------

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function makeSessionToken(email) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Date.now() + 8 * 60 * 60 * 1000
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/(?:^|;\s*)swids_session=([^;]+)/);
  if (!match) return null;

  const [payload, signature] = decodeURIComponent(match[1]).split(".");
  if (!payload || !signature) return null;

  const a = Buffer.from(signature);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.email || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: "Authentication required." });
  req.user = session;
  next();
}

// Catches errors from async routes so the server never crashes.
const wrap = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(err => {
    console.error(err);
    res.status(500).json({ error: "Server error. Please try again." });
  });

// ---------------- Database setup ----------------

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      kebele TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      status TEXT DEFAULT 'Active',
      notes TEXT DEFAULT '',
      id_number TEXT DEFAULT '',
      birth_date DATE,
      marital_status TEXT DEFAULT '',
      hire_date DATE,
      sector TEXT DEFAULT '',
      work_line TEXT DEFAULT '',
      department TEXT DEFAULT '',
      profession TEXT DEFAULT '',
      experience_years INTEGER,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      record_name TEXT DEFAULT '',
      category TEXT DEFAULT '',
      kebele TEXT DEFAULT '',
      period TEXT DEFAULT '',
      evaluator TEXT DEFAULT '',
      rating INTEGER NOT NULL,
      outcome TEXT DEFAULT 'Ongoing',
      comments TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await importLegacyJson();
}

// One-time import of old JSON data, only if the table is empty.
async function importLegacyJson() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM records");
  if (rows[0].n > 0 || !fs.existsSync(DATA_FILE)) return;

  let oldRecords;
  try {
    oldRecords = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(oldRecords)) return;

  const now = new Date().toISOString();
  for (const r of oldRecords) {
    try {
      await pool.query(
        `INSERT INTO records (id,name,category,kebele,phone,status,notes,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [r.id || crypto.randomUUID(), r.name || "", r.category || "", r.kebele || "",
         r.phone || "", r.status || "Active", r.notes || "",
         r.createdAt || now, r.updatedAt || r.createdAt || now]
      );
    } catch (err) {
      console.error("Skipped legacy record:", err.message);
    }
  }

  if (fs.existsSync(EVAL_FILE)) {
    try {
      const oldEvals = JSON.parse(fs.readFileSync(EVAL_FILE, "utf8"));
      for (const ev of Array.isArray(oldEvals) ? oldEvals : []) {
        try {
          await pool.query(
            `INSERT INTO evaluations (id,record_id,record_name,category,kebele,period,evaluator,rating,outcome,comments,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
            [ev.id || crypto.randomUUID(), ev.recordId, ev.recordName || "", ev.category || "",
             ev.kebele || "", ev.period || "", ev.evaluator || "", Number(ev.rating) || 1,
             ev.outcome || "Ongoing", ev.comments || "",
             ev.createdAt || now, ev.updatedAt || ev.createdAt || now]
          );
        } catch (err) {
          console.error("Skipped legacy evaluation:", err.message);
        }
      }
    } catch { /* ignore */ }
  }
  console.log(`Imported ${oldRecords.length} legacy record(s) from JSON.`);
}

// ---------------- Records helpers ----------------

const REC_COLS = `id, name, category, kebele, phone, status, notes, id_number,
  to_char(birth_date,'YYYY-MM-DD') AS birth_date, marital_status,
  to_char(hire_date,'YYYY-MM-DD') AS hire_date, sector, work_line, department,
  profession, experience_years, created_at, updated_at`;

function rowToRecord(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    kebele: r.kebele,
    phone: r.phone,
    status: r.status,
    notes: r.notes,
    idNumber: r.id_number,
    birthDate: r.birth_date,
    maritalStatus: r.marital_status,
    hireDate: r.hire_date,
    sector: r.sector,
    workLine: r.work_line,
    department: r.department,
    profession: r.profession,
    experienceYears: r.experience_years,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanDate(value) {
  const v = cleanText(value, 10);
  if (!v) return { value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return { error: true };
  return { value: v };
}

function validateRecord(body) {
  const record = {
    name: cleanText(body.name, 120),
    category: cleanText(body.category, 80),
    kebele: cleanText(body.kebele, 100),
    phone: cleanText(body.phone, 40),
    status: cleanText(body.status, 40),
    notes: cleanText(body.notes, 1000),
    idNumber: cleanText(body.idNumber, 50),
    maritalStatus: cleanText(body.maritalStatus, 30),
    sector: cleanText(body.sector, 100),
    workLine: cleanText(body.workLine, 100),
    department: cleanText(body.department, 100),
    profession: cleanText(body.profession, 100)
  };

  if (!record.name) return { error: "Name is required." };
  if (!record.category) return { error: "Category is required." };
  if (!record.status) record.status = "Active";

  const birth = cleanDate(body.birthDate);
  if (birth.error) return { error: "Date of birth is not a valid date." };
  record.birthDate = birth.value;

  const hire = cleanDate(body.hireDate);
  if (hire.error) return { error: "Date hired is not a valid date." };
  record.hireDate = hire.value;

  const expRaw = cleanText(body.experienceYears, 3);
  if (expRaw === "") {
    record.experienceYears = null;
  } else {
    const exp = Number(expRaw);
    if (!Number.isInteger(exp) || exp < 0 || exp > 60) {
      return { error: "Experience must be a whole number between 0 and 60." };
    }
    record.experienceYears = exp;
  }

  return { record };
}

// Order matches the $2..$16 placeholders below ($1 is the id).
function recordParams(r) {
  return [
    r.name, r.category, r.kebele, r.phone, r.status, r.notes,
    r.idNumber, r.birthDate, r.maritalStatus, r.hireDate,
    r.sector, r.workLine, r.department, r.profession, r.experienceYears
  ];
}

// ---------------- Evaluations helpers ----------------

const EVAL_OUTCOMES = ["Resolved", "Ongoing", "Escalated", "No Action Needed"];

function rowToEvaluation(r) {
  return {
    id: r.id,
    recordId: r.record_id,
    recordName: r.record_name,
    category: r.category,
    kebele: r.kebele,
    period: r.period,
    evaluator: r.evaluator,
    rating: r.rating,
    outcome: r.outcome,
    comments: r.comments,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

async function validateEvaluation(body) {
  const recordId = cleanText(body.recordId, 60);
  const found = await pool.query("SELECT id, name, category, kebele FROM records WHERE id = $1", [recordId]);
  const record = found.rows[0];
  if (!record) return { error: "Select a valid record to evaluate." };

  const period = cleanText(body.period, 40) || new Date().toISOString().slice(0, 10);

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { error: "Rating must be a whole number between 1 and 5." };
  }

  const outcome = cleanText(body.outcome, 40) || "Ongoing";
  if (!EVAL_OUTCOMES.includes(outcome)) {
    return { error: `Outcome must be one of: ${EVAL_OUTCOMES.join(", ")}.` };
  }

  return {
    evaluation: {
      recordId,
      recordName: record.name,
      category: record.category,
      kebele: record.kebele,
      period,
      evaluator: cleanText(body.evaluator, 120),
      rating,
      outcome,
      comments: cleanText(body.comments, 1000)
    }
  };
}

// ---------------- CSV / reporting helpers ----------------

function toCsv(rows, columns) {
  const escapeCsv = value => {
    const str = String(value ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = columns.map(c => c.label).join(",");
  const lines = rows.map(row => columns.map(c => escapeCsv(row[c.key])).join(","));
  return [header, ...lines].join("\n");
}

function sendCsv(res, filename, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // BOM so Excel shows Amharic/UTF-8 text correctly.
  res.send("\uFEFF" + csv);
}

function countBy(list, fn) {
  const counts = {};
  for (const item of list) {
    const key = fn(item) || "Unspecified";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ---------------- Routes: health & auth ----------------

app.get("/api/health", wrap(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, service: "SWIDS", db: "connected", time: new Date().toISOString() });
}));

app.post("/api/login", loginLimiter, async (req, res) => {
  const email = cleanText(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || "");

  if (email !== ADMIN_EMAIL.toLowerCase()) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const valid = await bcrypt.compare(password, await bcrypt.hash(ADMIN_PASSWORD, 10));
  if (!valid) return res.status(401).json({ error: "Invalid email or password." });

  const token = makeSessionToken(email);
  res.setHeader(
    "Set-Cookie",
    `swids_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
  );
  res.json({ ok: true, user: { email } });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "swids_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ authenticated: true, user: { email: req.user.email } });
});

// ---------------- Routes: records ----------------

app.get("/api/records", requireAuth, wrap(async (req, res) => {
  const q = cleanText(req.query.q, 100);
  const { rows } = await pool.query(
    `SELECT ${REC_COLS} FROM records
     WHERE ($1::text = '' OR concat_ws(' ', name, category, kebele, phone, status, notes,
            id_number, marital_status, sector, work_line, department, profession)
            ILIKE '%' || $1 || '%')
     ORDER BY updated_at DESC`,
    [q]
  );
  res.json({ records: rows.map(rowToRecord) });
}));

app.post("/api/records", requireAuth, wrap(async (req, res) => {
  const result = validateRecord(req.body);
  if (result.error) return res.status(400).json({ error: result.error });

  const { rows } = await pool.query(
    `INSERT INTO records
       (id, name, category, kebele, phone, status, notes, id_number, birth_date,
        marital_status, hire_date, sector, work_line, department, profession, experience_years)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${REC_COLS}`,
    [crypto.randomUUID(), ...recordParams(result.record)]
  );
  res.status(201).json({ record: rowToRecord(rows[0]) });
}));

app.put("/api/records/:id", requireAuth, wrap(async (req, res) => {
  const result = validateRecord(req.body);
  if (result.error) return res.status(400).json({ error: result.error });

  const { rows } = await pool.query(
    `UPDATE records SET
       name=$2, category=$3, kebele=$4, phone=$5, status=$6, notes=$7,
       id_number=$8, birth_date=$9, marital_status=$10, hire_date=$11,
       sector=$12, work_line=$13, department=$14, profession=$15,
       experience_years=$16, updated_at=now()
     WHERE id=$1
     RETURNING ${REC_COLS}`,
    [req.params.id, ...recordParams(result.record)]
  );
  if (!rows.length) return res.status(404).json({ error: "Record not found." });
  res.json({ record: rowToRecord(rows[0]) });
}));

app.delete("/api/records/:id", requireAuth, wrap(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM records WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Record not found." });
  res.json({ ok: true });
}));

// ---------------- Routes: evaluations ----------------

app.get("/api/evaluations", requireAuth, wrap(async (req, res) => {
  const recordId = cleanText(req.query.recordId, 60);
  const { rows } = await pool.query(
    `SELECT * FROM evaluations
     WHERE ($1::text = '' OR record_id = $1)
     ORDER BY updated_at DESC`,
    [recordId]
  );
  res.json({ evaluations: rows.map(rowToEvaluation) });
}));

app.post("/api/evaluations", requireAuth, wrap(async (req, res) => {
  const result = await validateEvaluation(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const e = result.evaluation;

  const { rows } = await pool.query(
    `INSERT INTO evaluations
       (id, record_id, record_name, category, kebele, period, evaluator, rating, outcome, comments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [crypto.randomUUID(), e.recordId, e.recordName, e.category, e.kebele,
     e.period, e.evaluator, e.rating, e.outcome, e.comments]
  );
  res.status(201).json({ evaluation: rowToEvaluation(rows[0]) });
}));

app.put("/api/evaluations/:id", requireAuth, wrap(async (req, res) => {
  const result = await validateEvaluation(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const e = result.evaluation;

  const { rows } = await pool.query(
    `UPDATE evaluations SET
       record_id=$2, record_name=$3, category=$4, kebele=$5, period=$6,
       evaluator=$7, rating=$8, outcome=$9, comments=$10, updated_at=now()
     WHERE id=$1
     RETURNING *`,
    [req.params.id, e.recordId, e.recordName, e.category, e.kebele,
     e.period, e.evaluator, e.rating, e.outcome, e.comments]
  );
  if (!rows.length) return res.status(404).json({ error: "Evaluation not found." });
  res.json({ evaluation: rowToEvaluation(rows[0]) });
}));

app.delete("/api/evaluations/:id", requireAuth, wrap(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM evaluations WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Evaluation not found." });
  res.json({ ok: true });
}));

// ---------------- Routes: reporting ----------------

app.get("/api/reports/summary", requireAuth, wrap(async (req, res) => {
  const recs = (await pool.query("SELECT category, status, kebele FROM records")).rows;
  const evals = (await pool.query("SELECT rating, outcome FROM evaluations")).rows;

  const averageRating = evals.length
    ? Number((evals.reduce((s, e) => s + Number(e.rating || 0), 0) / evals.length).toFixed(2))
    : null;

  res.json({
    totalRecords: recs.length,
    activeRecords: recs.filter(r => r.status === "Active").length,
    totalEvaluations: evals.length,
    averageRating,
    byCategory: countBy(recs, r => r.category),
    byStatus: countBy(recs, r => r.status),
    byKebele: countBy(recs, r => r.kebele),
    byOutcome: countBy(evals, e => e.outcome)
  });
}));

app.get("/api/reports/export/records.csv", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${REC_COLS} FROM records ORDER BY name`);
  const csv = toCsv(rows.map(rowToRecord), [
    { key: "name", label: "Name" },
    { key: "category", label: "Category" },
    { key: "kebele", label: "Kebele" },
    { key: "phone", label: "Phone" },
    { key: "status", label: "Status" },
    { key: "idNumber", label: "ID Number" },
    { key: "birthDate", label: "Date of Birth" },
    { key: "maritalStatus", label: "Marital Status" },
    { key: "hireDate", label: "Date Hired" },
    { key: "sector", label: "Sector" },
    { key: "workLine", label: "Work Line" },
    { key: "department", label: "Department" },
    { key: "profession", label: "Profession" },
    { key: "experienceYears", label: "Experience (years)" },
    { key: "notes", label: "Notes" },
    { key: "createdAt", label: "Created At" },
    { key: "updatedAt", label: "Updated At" }
  ]);
  sendCsv(res, "records.csv", csv);
}));

app.get("/api/reports/export/evaluations.csv", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM evaluations ORDER BY updated_at DESC");
  const csv = toCsv(rows.map(rowToEvaluation), [
    { key: "recordName", label: "Record" },
    { key: "category", label: "Category" },
    { key: "kebele", label: "Kebele" },
    { key: "period", label: "Period" },
    { key: "evaluator", label: "Evaluator" },
    { key: "rating", label: "Rating" },
    { key: "outcome", label: "Outcome" },
    { key: "comments", label: "Comments" },
    { key: "updatedAt", label: "Last Updated" }
  ]);
  sendCsv(res, "evaluations.csv", csv);
}));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------- Start ----------------

let server;
initDb()
  .then(() => {
    server = app.listen(PORT, () => {
      console.log(`SWIDS running on http://localhost:${PORT} (PostgreSQL connected)`);
    });
  })
  .catch(err => {
    console.error("Database setup failed:", err);
    process.exit(1);
  });

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  const done = () => pool.end().finally(() => process.exit(0));
  if (server) server.close(done); else done();

  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
});
