const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config();
const citizen = require("./citizen-reports");
const officerReports = require("./officer-reports");

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 5000);

// Old JSON files: only used for a one-time import into PostgreSQL.
const DATA_FILE = path.resolve(process.env.DATA_FILE || "./data/records.json");
const EVAL_FILE = path.resolve(process.env.EVAL_FILE || "./data/evaluations.json");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-this-secret";
const DATABASE_URL = process.env.DATABASE_URL;

// FIX 1: these checks no longer depend on NODE_ENV, so weak defaults can
// never run by accident (for example if NODE_ENV is forgotten on the host).
if (SESSION_SECRET === "dev-only-change-this-secret" || SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be set to a random value of 32+ characters.");
}
if (ADMIN_PASSWORD === "change-me" || ADMIN_PASSWORD.length < 8) {
  throw new Error("ADMIN_PASSWORD must be changed (at least 8 characters).");
}
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required (PostgreSQL connection string).");
}

// Hash the admin password once at startup instead of on every login.
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|@dpg-[a-z0-9]+-a[:\/]/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
});

// FIX 2: a dropped idle database connection must not crash the server.
pool.on("error", err => {
  console.error("Idle database client error:", err.message);
});

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
      "script-src-attr": ["'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
    },
  },
}));
// Citizen reports can carry up to 3 photos (base64), so this route gets a bigger limit.
// It must come BEFORE the general parser below.
app.use("/api/citizen-reports", express.json({ limit: "2mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], index: false }));
app.get("/", (req, res) => {
  fs.readFile(path.join(__dirname, "public", "home.html"), "utf8", (err, html) => {
    if (err) return res.status(500).send("Page not found");
    const tag = '<script src="/news-home.js"></script>';
    if (!html.includes("news-home.js")) {
      html = /<\/body>/i.test(html)
        ? html.replace(/<\/body>/i, tag + "</body>")
        : html + tag;
    }
    res.type("html").send(html);
  });
});
app.get("/manifest.json", (req, res) => res.sendFile(path.join(__dirname, "manifest.json")));
app.get("/icon-192.png", (req, res) => res.sendFile(path.join(__dirname, "icon-192.png")));
app.get("/icon-512.png", (req, res) => res.sendFile(path.join(__dirname, "icon-512.png")));
app.get("/sw.js", (req, res) => res.sendFile(path.join(__dirname, "sw.js")));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

// FIX 4: rate limits for the open (no login) endpoints.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." }
});
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions. Try again later." }
});
app.use("/api/public", publicLimiter);
// Assumes citizens submit with POST /api/citizen-reports. If your
// citizen-reports.js uses a different path, change it here.
app.post("/api/citizen-reports", submitLimiter);

// Catches errors from async routes so the server never crashes.
const wrap = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(err => {
    console.error(err);
    res.status(500).json({ error: "Server error. Please try again." });
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

  // FIX 3: a malformed cookie now returns "not signed in" instead of a 500 error.
  let decoded;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const [payload, signature] = decoded.split(".");
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

// Loads the current user (role and scope) fresh from the database, so a
// deactivated user or a changed role takes effect immediately.
async function loadUser(email) {
  if (email === ADMIN_EMAIL) {
    return { email, name: "Woreda Administrator", role: "admin", kebele: null, sector: null };
  }
  const { rows } = await pool.query(
    "SELECT email, name, role, kebele, sector FROM users WHERE email = $1 AND active = true",
    [email]
  );
  return rows[0] || null;
}

const requireAuth = wrap(async (req, res, next) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: "Authentication required." });
  const user = await loadUser(session.email);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  req.user = user;
  next();
});

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
  next();
}

// ---------------- Roles and data scope ----------------
// admin          -> sees everything
// sector_head    -> sees records of their sector, across all kebeles
// sector_officer -> works under a sector head; sees records of their sector
// kebele_officer -> sees records of their kebele only
// A scoped user with no kebele/sector assigned sees nothing (safe default).

const ROLES = ["admin", "sector_head", "sector_officer", "kebele_officer"];

function scopeClause(user, params, cols = {}) {
  const k = cols.kebele || "kebele";
  const s = cols.sector || "sector";
  if (user.role === "kebele_officer") {
    params.push(user.kebele);
    return `${k} = $${params.length}`;
  }
  if (user.role === "sector_head" || user.role === "sector_officer") {
    params.push(user.sector);
    return `${s} = $${params.length}`;
  }
  if (user.role === "admin") return "TRUE";
  return "FALSE"; // unknown role: see nothing
}

// Evaluations are scoped through the record they belong to.
function evalScopeClause(user, params) {
  return `record_id IN (SELECT id FROM records WHERE ${scopeClause(user, params)})`;
}

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

    CREATE TABLE IF NOT EXISTS kebeles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS sectors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','sector_head','sector_officer','kebele_officer')),
      kebele TEXT,
      sector TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // NEW: job role column on records (Expert, Team Leader, ...). Safe to run every start.
  await pool.query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS job_role TEXT DEFAULT ''`);

  // Existing databases were created with only three allowed roles. Widen the
  // rule once so the new sector_officer role can be saved. Safe to run every start.
  await pool.query(`
    DO $$
    DECLARE def text;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO def
        FROM pg_constraint
       WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass;
      IF def IS NOT NULL AND def NOT LIKE '%sector_officer%' THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check
          CHECK (role IN ('admin','sector_head','sector_officer','kebele_officer'));
      END IF;
    END $$;
  `);

  await citizen.initTables(pool);
  await officerReports.initTables(pool);
  await importLegacyJson();
  await seedLists();
}

// First run only: fill the Kebele and Sector lists from the values already
// typed in records. Clean up typos afterwards by renaming in the Admin Panel.
async function seedLists() {
  const k = await pool.query("SELECT COUNT(*)::int AS n FROM kebeles");
  if (k.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO kebeles (name)
       SELECT DISTINCT btrim(kebele) FROM records WHERE btrim(kebele) <> ''
       ON CONFLICT DO NOTHING`
    );
  }
  const s = await pool.query("SELECT COUNT(*)::int AS n FROM sectors");
  if (s.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO sectors (name)
       SELECT DISTINCT btrim(sector) FROM records WHERE btrim(sector) <> ''
       ON CONFLICT DO NOTHING`
    );
  }
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
  profession, job_role, experience_years, created_at, updated_at`;

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
    jobRole: r.job_role,
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
    profession: cleanText(body.profession, 100),
    jobRole: cleanText(body.jobRole, 100)
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

// Applies the user's scope to a record, then checks Kebele and Sector
// against the managed lists.
async function applyScopeAndLists(user, record) {
  if (user.role === "kebele_officer") record.kebele = user.kebele || "";
  if (user.role === "sector_head" || user.role === "sector_officer") record.sector = user.sector || "";

  if (user.role === "kebele_officer" && !user.kebele) {
    return "Your account has no kebele assigned. Ask the administrator.";
  }
  if ((user.role === "sector_head" || user.role === "sector_officer") && !user.sector) {
    return "Your account has no sector assigned. Ask the administrator.";
  }

  for (const [table, field, label] of [["kebeles", "kebele", "Kebele"], ["sectors", "sector", "Sector"]]) {
    const value = record[field];
    if (!value) continue;
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE active = true`);
    if (total.rows[0].n === 0) continue; // list not set up yet: allow
    const ok = await pool.query(`SELECT 1 FROM ${table} WHERE name = $1 AND active = true`, [value]);
    if (!ok.rowCount) return `${label} "${value}" is not in the ${label} list. Choose one from the list.`;
  }
  return null;
}

// Order matches the $2..$17 placeholders below ($1 is the id).
function recordParams(r) {
  return [
    r.name, r.category, r.kebele, r.phone, r.status, r.notes,
    r.idNumber, r.birthDate, r.maritalStatus, r.hireDate,
    r.sector, r.workLine, r.department, r.profession, r.experienceYears,
    r.jobRole
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

async function validateEvaluation(body, user) {
  const recordId = cleanText(body.recordId, 60);
  const params = [recordId];
  const found = await pool.query(
    `SELECT id, name, category, kebele FROM records WHERE id = $1 AND ${scopeClause(user, params)}`,
    params
  );
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
  const cell = value => {
    let str = String(value ?? "");
    // Block spreadsheet formula injection. Plain phone-style numbers
    // (e.g. +251911223344) are left alone so they stay readable.
    if (/^[=+\-@\t\r]/.test(str) && !/^[+-]?[\d\s()-]+$/.test(str)) {
      str = "'" + str;
    }
    return `"${str.replace(/"/g, '""')}"`;
  };
  const header = columns.map(c => cell(c.label)).join(",");
  const lines = rows.map(row => columns.map(c => cell(row[c.key])).join(","));
  return [header, ...lines].join("\r\n");
}

function sendCsv(res, filename, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // BOM so Excel shows Amharic/UTF-8 text correctly.
  res.send("\uFEFF" + csv);
}

// FIX 5: counts are computed inside PostgreSQL (GROUP BY) instead of loading
// every row into memory. Only called with fixed table/column names from this
// file, never with user input.
async function groupCount(table, col, where, params) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(btrim(${col}), ''), 'Unspecified') AS k, COUNT(*)::int AS n
       FROM ${table} WHERE ${where} GROUP BY 1`,
    params
  );
  return Object.fromEntries(rows.map(r => [r.k, r.n]));
}

// ---------------- Routes: health & auth ----------------

app.get("/api/health", wrap(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, service: "SWIDS", db: "connected", time: new Date().toISOString() });
}));

app.post("/api/login", loginLimiter, wrap(async (req, res) => {
  const email = cleanText(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || "");

  // Always run one bcrypt compare so a wrong email and a wrong password
  // take about the same time.
  let valid = false;
  const found = await pool.query("SELECT password_hash FROM users WHERE email = $1 AND active = true", [email]);
  if (found.rows[0]) {
    valid = await bcrypt.compare(password, found.rows[0].password_hash);
  } else {
    const ok = await bcrypt.compare(password, ADMIN_HASH);
    valid = ok && email === ADMIN_EMAIL;
  }
  if (!valid) return res.status(401).json({ error: "Invalid email or password." });

  const token = makeSessionToken(email);
  // "Secure" is added whenever the request arrived over HTTPS (works behind
  // Render thanks to "trust proxy"), not only when NODE_ENV is "production".
  res.setHeader(
    "Set-Cookie",
    `swids_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${req.secure ? "; Secure" : ""}`
  );
  const user = await loadUser(email);
  res.json({ ok: true, user });
}));

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "swids_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ authenticated: true, user: req.user });
});

// ---------------- Routes: Kebele and Sector lists ----------------
// Anyone signed in can read the lists (for dropdowns). Only the administrator
// can add, rename, or deactivate. Renaming also updates every place that uses
// the old name, so a typo can be fixed in one place.
// cascade entries: [table, column] or [table, column, extraWhere]

function listRoutes(route, table, cascade) {
  app.get(`/api/${route}`, requireAuth, wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT id, name, active FROM ${table} ORDER BY name`);
    res.json({ items: rows });
  }));

  app.post(`/api/${route}`, requireAuth, requireAdmin, wrap(async (req, res) => {
    const name = cleanText(req.body.name, 100);
    if (!name) return res.status(400).json({ error: "Name is required." });
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${table} (name) VALUES ($1) RETURNING id, name, active`, [name]
      );
      res.status(201).json({ item: rows[0] });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "That name already exists." });
      throw err;
    }
  }));

  app.put(`/api/${route}/:id`, requireAuth, requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(`SELECT name, active FROM ${table} WHERE id = $1`, [id]);
      if (!cur.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Not found." });
      }
      const oldName = cur.rows[0].name;
      const newName = req.body.name === undefined ? oldName : cleanText(req.body.name, 100);
      const active = req.body.active === undefined ? cur.rows[0].active : Boolean(req.body.active);
      if (!newName) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Name is required." });
      }

      const { rows } = await client.query(
        `UPDATE ${table} SET name = $2, active = $3 WHERE id = $1 RETURNING id, name, active`,
        [id, newName, active]
      );
      if (newName !== oldName) {
        for (const [t, col, where] of cascade) {
          // Skip tables that do not exist (yet), so a rename never fails because of them.
          const exists = await client.query("SELECT to_regclass($1) AS t", [t]);
          if (!exists.rows[0].t) continue;
          await client.query(
            `UPDATE ${t} SET ${col} = $1 WHERE ${col} = $2${where ? " AND " + where : ""}`,
            [newName, oldName]
          );
        }
      }
      await client.query("COMMIT");
      res.json({ item: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code === "23505") return res.status(409).json({ error: "That name already exists." });
      throw err;
    } finally {
      client.release();
    }
  }));
}

listRoutes("kebeles", "kebeles", [
  ["records", "kebele"], ["evaluations", "kebele"], ["users", "kebele"],
  ["citizen_reports", "kebele"], ["announcements", "audience"],
  ["periodic_reports", "unit_name", "unit_type='kebele'"]
]);
listRoutes("sectors", "sectors", [
  ["records", "sector"], ["users", "sector"], ["officer_reports", "sector"],
  ["announcements", "audience"], ["periodic_reports", "unit_name", "unit_type='sector'"]
]);

// ---------------- Routes: users (administrator only) ----------------

function userView(r) {
  return { id: r.id, email: r.email, name: r.name, role: r.role, kebele: r.kebele, sector: r.sector, active: r.active };
}

function checkUserScope(role, kebele, sector) {
  if (!ROLES.includes(role)) return "Role must be admin, sector_head, sector_officer, or kebele_officer.";
  if (role === "kebele_officer" && !kebele) return "A kebele officer needs a kebele.";
  if (role === "sector_head" && !sector) return "A sector head needs a sector.";
  if (role === "sector_officer" && !sector) return "A sector officer needs a sector.";
  return null;
}

app.get("/api/users", requireAuth, requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT id, email, name, role, kebele, sector, active FROM users ORDER BY email");
  res.json({ users: rows.map(userView) });
}));

app.post("/api/users", requireAuth, requireAdmin, wrap(async (req, res) => {
  const email = cleanText(req.body.email, 200).toLowerCase();
  const name = cleanText(req.body.name, 120);
  const password = String(req.body.password || "");
  const role = cleanText(req.body.role, 30);
  const kebele = cleanText(req.body.kebele, 100) || null;
  const sector = cleanText(req.body.sector, 100) || null;

  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "A valid email is required." });
  if (email === ADMIN_EMAIL) return res.status(400).json({ error: "That email is reserved for the main administrator." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const scopeError = checkUserScope(role, kebele, sector);
  if (scopeError) return res.status(400).json({ error: scopeError });

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role, kebele, sector)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, email, name, role, kebele, sector, active`,
      [crypto.randomUUID(), email, name, await bcrypt.hash(password, 10), role,
       role === "kebele_officer" ? kebele : null, (role === "sector_head" || role === "sector_officer") ? sector : null]
    );
    res.status(201).json({ user: userView(rows[0]) });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That email already exists." });
    throw err;
  }
}));

app.put("/api/users/:id", requireAuth, requireAdmin, wrap(async (req, res) => {
  const cur = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
  if (!cur.rowCount) return res.status(404).json({ error: "User not found." });
  const u = cur.rows[0];

  const role = req.body.role === undefined ? u.role : cleanText(req.body.role, 30);
  const kebele = req.body.kebele === undefined ? u.kebele : (cleanText(req.body.kebele, 100) || null);
  const sector = req.body.sector === undefined ? u.sector : (cleanText(req.body.sector, 100) || null);
  const name = req.body.name === undefined ? u.name : cleanText(req.body.name, 120);
  const active = req.body.active === undefined ? u.active : Boolean(req.body.active);

  const scopeError = checkUserScope(role, kebele, sector);
  if (scopeError) return res.status(400).json({ error: scopeError });

  let hash = u.password_hash;
  if (req.body.password) {
    const pw = String(req.body.password);
    if (pw.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    hash = await bcrypt.hash(pw, 10);
  }

  const { rows } = await pool.query(
    `UPDATE users SET name=$2, role=$3, kebele=$4, sector=$5, active=$6, password_hash=$7
     WHERE id=$1 RETURNING id, email, name, role, kebele, sector, active`,
    [u.id, name, role, role === "kebele_officer" ? kebele : null, (role === "sector_head" || role === "sector_officer") ? sector : null, active, hash]
  );
  res.json({ user: userView(rows[0]) });
}));

// ---------------- Routes: records ----------------

app.get("/api/records", requireAuth, wrap(async (req, res) => {
  // Returns at most 500 records per request. Use ?limit= and ?offset= to page.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const params = [cleanText(req.query.q, 100)];
  const scope = scopeClause(req.user, params);
  const { rows } = await pool.query(
    `SELECT ${REC_COLS} FROM records
     WHERE ($1::text = '' OR concat_ws(' ', name, category, kebele, phone, status, notes,
            id_number, marital_status, sector, work_line, department, profession, job_role)
            ILIKE '%' || $1 || '%')
       AND ${scope}
     ORDER BY updated_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ records: rows.map(rowToRecord) });
}));

app.post("/api/records", requireAuth, wrap(async (req, res) => {
  const result = validateRecord(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const problem = await applyScopeAndLists(req.user, result.record);
  if (problem) return res.status(400).json({ error: problem });

  const { rows } = await pool.query(
    `INSERT INTO records
       (id, name, category, kebele, phone, status, notes, id_number, birth_date,
        marital_status, hire_date, sector, work_line, department, profession, experience_years, job_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${REC_COLS}`,
    [crypto.randomUUID(), ...recordParams(result.record)]
  );
  res.status(201).json({ record: rowToRecord(rows[0]) });
}));

app.put("/api/records/:id", requireAuth, wrap(async (req, res) => {
  const result = validateRecord(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const problem = await applyScopeAndLists(req.user, result.record);
  if (problem) return res.status(400).json({ error: problem });

  const params = [req.params.id, ...recordParams(result.record)];
  const scope = scopeClause(req.user, params);
  const { rows } = await pool.query(
    `UPDATE records SET
       name=$2, category=$3, kebele=$4, phone=$5, status=$6, notes=$7,
       id_number=$8, birth_date=$9, marital_status=$10, hire_date=$11,
       sector=$12, work_line=$13, department=$14, profession=$15,
       experience_years=$16, job_role=$17, updated_at=now()
     WHERE id=$1 AND ${scope}
     RETURNING ${REC_COLS}`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: "Record not found." });
  res.json({ record: rowToRecord(rows[0]) });
}));

app.delete("/api/records/:id", requireAuth, wrap(async (req, res) => {
  const params = [req.params.id];
  const scope = scopeClause(req.user, params);
  const { rowCount } = await pool.query(`DELETE FROM records WHERE id = $1 AND ${scope}`, params);
  if (!rowCount) return res.status(404).json({ error: "Record not found." });
  res.json({ ok: true });
}));

// ---------------- Routes: evaluations ----------------

app.get("/api/evaluations", requireAuth, wrap(async (req, res) => {
  const params = [cleanText(req.query.recordId, 60)];
  const scope = evalScopeClause(req.user, params);
  const { rows } = await pool.query(
    `SELECT * FROM evaluations
     WHERE ($1::text = '' OR record_id = $1) AND ${scope}
     ORDER BY updated_at DESC`,
    params
  );
  res.json({ evaluations: rows.map(rowToEvaluation) });
}));

app.post("/api/evaluations", requireAuth, wrap(async (req, res) => {
  const result = await validateEvaluation(req.body, req.user);
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
  const result = await validateEvaluation(req.body, req.user);
  if (result.error) return res.status(400).json({ error: result.error });
  const e = result.evaluation;

  const params = [req.params.id, e.recordId, e.recordName, e.category, e.kebele, e.period,
    e.evaluator, e.rating, e.outcome, e.comments];
  const scope = evalScopeClause(req.user, params);
  const { rows } = await pool.query(
    `UPDATE evaluations SET
       record_id=$2, record_name=$3, category=$4, kebele=$5, period=$6,
       evaluator=$7, rating=$8, outcome=$9, comments=$10, updated_at=now()
     WHERE id=$1 AND ${scope}
     RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: "Evaluation not found." });
  res.json({ evaluation: rowToEvaluation(rows[0]) });
}));

app.delete("/api/evaluations/:id", requireAuth, wrap(async (req, res) => {
  const params = [req.params.id];
  const scope = evalScopeClause(req.user, params);
  const { rowCount } = await pool.query(`DELETE FROM evaluations WHERE id = $1 AND ${scope}`, params);
  if (!rowCount) return res.status(404).json({ error: "Evaluation not found." });
  res.json({ ok: true });
}));

// ---------------- Routes: reporting ----------------

app.get("/api/reports/summary", requireAuth, wrap(async (req, res) => {
  const rp = [];
  const ep = [];
  const recordScope = scopeClause(req.user, rp);
  const evalScope = evalScopeClause(req.user, ep);

  const [byCategory, byStatus, byKebele, bySector, byOutcome, evalStats] = await Promise.all([
    groupCount("records", "category", recordScope, rp),
    groupCount("records", "status", recordScope, rp),
    groupCount("records", "kebele", recordScope, rp),
    groupCount("records", "sector", recordScope, rp),
    groupCount("evaluations", "outcome", evalScope, ep),
    pool.query(`SELECT COUNT(*)::int AS n, AVG(rating) AS avg FROM evaluations WHERE ${evalScope}`, ep)
  ]);

  const avg = evalStats.rows[0].avg;
  res.json({
    totalRecords: Object.values(byCategory).reduce((a, b) => a + b, 0),
    activeRecords: byStatus["Active"] || 0,
    totalEvaluations: evalStats.rows[0].n,
    averageRating: avg === null ? null : Number(Number(avg).toFixed(2)),
    byCategory,
    byStatus,
    byKebele,
    bySector,
    byOutcome
  });
}));

// Public summary: aggregate counts only (no login). No names, record details or evaluations.
app.get("/api/public/summary", wrap(async (req, res) => {
  const [byCategory, byStatus, byKebele] = await Promise.all([
    groupCount("records", "category", "TRUE", []),
    groupCount("records", "status", "TRUE", []),
    groupCount("records", "kebele", "TRUE", [])
  ]);
  res.json({
    totalRecords: Object.values(byCategory).reduce((a, b) => a + b, 0),
    activeRecords: byStatus["Active"] || 0,
    byCategory,
    byKebele
  });
}));

app.get("/api/reports/export/records.csv", requireAuth, wrap(async (req, res) => {
  const params = [];
  const { rows } = await pool.query(
    `SELECT ${REC_COLS} FROM records WHERE ${scopeClause(req.user, params)} ORDER BY name`, params
  );
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
    { key: "jobRole", label: "Job Role" },
    { key: "experienceYears", label: "Experience (years)" },
    { key: "notes", label: "Notes" },
    { key: "createdAt", label: "Created At" },
    { key: "updatedAt", label: "Updated At" }
  ]);
  sendCsv(res, "records.csv", csv);
}));

app.get("/api/reports/export/evaluations.csv", requireAuth, wrap(async (req, res) => {
  const params = [];
  const { rows } = await pool.query(
    `SELECT * FROM evaluations WHERE ${evalScopeClause(req.user, params)} ORDER BY updated_at DESC`, params
  );
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

// ---------------- Routes: citizen reports & announcements ----------------
citizen.mount(app, { pool, wrap, requireAuth, cleanText });

// ---------------- Routes: sector officer reports & head feedback ----------------
officerReports.mount(app, { pool, wrap, requireAuth, cleanText });
// ---------------- Routes: news ----------------
require("./news").mount(app, { pool, wrap, requireAuth });

// Unknown /api routes return JSON 404 instead of the HTML page below.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

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
