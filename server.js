const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const DATA_FILE = path.resolve(process.env.DATA_FILE || "./data/records.json");
const EVAL_FILE = path.resolve(process.env.EVAL_FILE || "./data/evaluations.json");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-this-secret";

if (process.env.NODE_ENV === "production" && SESSION_SECRET === "dev-only-change-this-secret") {
  throw new Error("SESSION_SECRET must be changed in production.");
}
if (process.env.NODE_ENV === "production" && ADMIN_PASSWORD === "change-me") {
  throw new Error("ADMIN_PASSWORD must be changed in production.");
}

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

fs.mkdirSync(path.dirname(EVAL_FILE), { recursive: true });
if (!fs.existsSync(EVAL_FILE)) fs.writeFileSync(EVAL_FILE, "[]", "utf8");

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

// Lightweight signed cookie session, avoiding a database dependency.
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
  const match = raw.match(/(?:^|;\\s*)swids_session=([^;]+)/);
  if (!match) return null;

  const [payload, signature] = decodeURIComponent(match[1]).split(".");
  if (!payload || !signature || !crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(sign(payload))
  )) return null;

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

function readRecords() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Could not read data:", err);
    return [];
  }
}

function writeRecords(records) {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

function readEvaluations() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EVAL_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Could not read evaluations:", err);
    return [];
  }
}

function writeEvaluations(evaluations) {
  const tmp = `${EVAL_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(evaluations, null, 2), "utf8");
  fs.renameSync(tmp, EVAL_FILE);
}

const EVAL_CRITERIA = ["quality", "productivity", "teamwork", "attendance", "initiative"];

function validateEvaluation(body, employeeRecords) {
  const employeeId = cleanText(body.employeeId, 60);
  const employee = employeeRecords.find(r => r.id === employeeId);
  if (!employee) return { error: "Select a valid employee." };

  const period = cleanText(body.period, 40);
  if (!period) return { error: "Evaluation period is required." };

  const criteria = {};
  for (const key of EVAL_CRITERIA) {
    const raw = body.criteria ? body.criteria[key] : undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      return { error: `Score for "${key}" must be a number between 1 and 5.` };
    }
    criteria[key] = value;
  }

  const overallScore = Number(
    (EVAL_CRITERIA.reduce((sum, key) => sum + criteria[key], 0) / EVAL_CRITERIA.length).toFixed(2)
  );

  const evaluation = {
    employeeId,
    employeeName: employee.name,
    department: employee.department || "",
    period,
    reviewer: cleanText(body.reviewer, 120),
    criteria,
    overallScore,
    comments: cleanText(body.comments, 1000)
  };

  return { evaluation };
}

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
  res.send(csv);
}

function countBy(list, fn) {
  const counts = {};
  for (const item of list) {
    const key = fn(item) || "Unspecified";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function validateRecord(body) {
  const record = {
    name: cleanText(body.name, 120),
    category: cleanText(body.category, 80),
    kebele: cleanText(body.kebele, 100),
    phone: cleanText(body.phone, 40),
    status: cleanText(body.status, 40),
    notes: cleanText(body.notes, 1000)
  };

  if (!record.name) return { error: "Name is required." };
  if (!record.category) return { error: "Category is required." };
  if (!record.status) record.status = "Active";

  return { record };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "SWIDS", time: new Date().toISOString() });
});

app.post("/api/login", loginLimiter, async (req, res) => {
  const email = cleanText(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || "");

  if (email !== ADMIN_EMAIL.toLowerCase()) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  // Supports a plain env password for the starter while comparing safely.
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
  res.setHeader(
    "Set-Cookie",
    "swids_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  );
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ authenticated: true, user: { email: req.user.email } });
});

app.get("/api/records", requireAuth, (req, res) => {
  const q = cleanText(req.query.q, 100).toLowerCase();
  let records = readRecords();

  if (q) {
    records = records.filter(r =>
      [r.name, r.category, r.kebele, r.phone, r.status, r.notes]
        .some(v => String(v || "").toLowerCase().includes(q))
    );
  }

  records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json({ records });
});

app.post("/api/records", requireAuth, (req, res) => {
  const result = validateRecord(req.body);
  if (result.error) return res.status(400).json({ error: result.error });

  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    ...result.record,
    createdAt: now,
    updatedAt: now
  };

  const records = readRecords();
  records.push(record);
  writeRecords(records);
  res.status(201).json({ record });
});

app.put("/api/records/:id", requireAuth, (req, res) => {
  const result = validateRecord(req.body);
  if (result.error) return res.status(400).json({ error: result.error });

  const records = readRecords();
  const index = records.findIndex(r => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Record not found." });

  records[index] = {
    ...records[index],
    ...result.record,
    updatedAt: new Date().toISOString()
  };

  writeRecords(records);
  res.json({ record: records[index] });
});

app.delete("/api/records/:id", requireAuth, (req, res) => {
  const records = readRecords();
  const filtered = records.filter(r => r.id !== req.params.id);

  if (filtered.length === records.length) {
    return res.status(404).json({ error: "Record not found." });
  }

  writeRecords(filtered);
  res.json({ ok: true });
});

// ---------------- Performance evaluations ----------------

app.get("/api/evaluations", requireAuth, (req, res) => {
  const employeeId = cleanText(req.query.employeeId, 60);
  let evaluations = readEvaluations();

  if (employeeId) {
    evaluations = evaluations.filter(ev => ev.employeeId === employeeId);
  }

  evaluations.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json({ evaluations });
});

app.post("/api/evaluations", requireAuth, (req, res) => {
  const employeeRecords = readRecords();
  const result = validateEvaluation(req.body, employeeRecords);
  if (result.error) return res.status(400).json({ error: result.error });

  const now = new Date().toISOString();
  const evaluation = {
    id: crypto.randomUUID(),
    ...result.evaluation,
    createdAt: now,
    updatedAt: now
  };

  const evaluations = readEvaluations();
  evaluations.push(evaluation);
  writeEvaluations(evaluations);
  res.status(201).json({ evaluation });
});

app.put("/api/evaluations/:id", requireAuth, (req, res) => {
  const employeeRecords = readRecords();
  const result = validateEvaluation(req.body, employeeRecords);
  if (result.error) return res.status(400).json({ error: result.error });

  const evaluations = readEvaluations();
  const index = evaluations.findIndex(ev => ev.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Evaluation not found." });

  evaluations[index] = {
    ...evaluations[index],
    ...result.evaluation,
    updatedAt: new Date().toISOString()
  };

  writeEvaluations(evaluations);
  res.json({ evaluation: evaluations[index] });
});

app.delete("/api/evaluations/:id", requireAuth, (req, res) => {
  const evaluations = readEvaluations();
  const filtered = evaluations.filter(ev => ev.id !== req.params.id);

  if (filtered.length === evaluations.length) {
    return res.status(404).json({ error: "Evaluation not found." });
  }

  writeEvaluations(filtered);
  res.json({ ok: true });
});

// ---------------- Reporting ----------------

app.get("/api/reports/summary", requireAuth, (req, res) => {
  const records = readRecords();
  const evaluations = readEvaluations();

  const activeEmployees = records.filter(r => r.status === "Active").length;

  const averageScore = evaluations.length
    ? Number(
        (evaluations.reduce((sum, ev) => sum + Number(ev.overallScore || 0), 0) / evaluations.length).toFixed(2)
      )
    : null;

  res.json({
    totalEmployees: records.length,
    activeEmployees,
    totalEvaluations: evaluations.length,
    averageScore,
    byDepartment: countBy(records, r => r.department),
    byStatus: countBy(records, r => r.status),
    byEmploymentType: countBy(records, r => r.employmentType),
    byGender: countBy(records, r => r.gender)
  });
});

app.get("/api/reports/export/records.csv", requireAuth, (req, res) => {
  const records = readRecords();
  const csv = toCsv(records, [
    { key: "name", label: "Name" },
    { key: "employeeId", label: "Employee ID" },
    { key: "department", label: "Department" },
    { key: "position", label: "Position" },
    { key: "employmentType", label: "Employment Type" },
    { key: "status", label: "Status" },
    { key: "phone", label: "Phone" },
    { key: "kebele", label: "Kebele" },
    { key: "hireDate", label: "Hire Date" },
    { key: "gender", label: "Gender" }
  ]);
  sendCsv(res, "employees.csv", csv);
});

app.get("/api/reports/export/evaluations.csv", requireAuth, (req, res) => {
  const evaluations = readEvaluations();
  const csv = toCsv(evaluations, [
    { key: "employeeName", label: "Employee" },
    { key: "department", label: "Department" },
    { key: "period", label: "Period" },
    { key: "reviewer", label: "Reviewer" },
    { key: "overallScore", label: "Overall Score" },
    { key: "comments", label: "Comments" },
    { key: "updatedAt", label: "Last Updated" }
  ]);
  sendCsv(res, "evaluations.csv", csv);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin_panel.html"));
});

app.listen(PORT, () => {
  console.log(`SWIDS running on http://localhost:${PORT}`);
});
