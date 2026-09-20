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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(ADMIN_PASSWORD, 10);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-this-secret";

if (process.env.NODE_ENV === "production" && SESSION_SECRET === "dev-only-change-this-secret") {
  throw new Error("SESSION_SECRET must be changed in production.");
}
if (process.env.NODE_ENV === "production" && ADMIN_PASSWORD === "change-me" && !process.env.ADMIN_PASSWORD_HASH) {
  throw new Error("ADMIN_PASSWORD or ADMIN_PASSWORD_HASH must be changed in production.");
}

const allowedOrigin = process.env.FRONTEND_ORIGIN || "https://shashogo-woreda-frontend.onrender.com";
app.use((req, res, next) => {
  if (allowedOrigin === "*") {
    res.header("Access-Control-Allow-Origin", "*");
  } else {
    res.header("Access-Control-Allow-Origin", allowedOrigin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

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

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function makeSessionToken(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const match = (req.headers.cookie || "").match(/(?:^|;\s*)swids_session=([^;]+)/);
  if (!match) return null;
  try {
    const [payload, signature] = decodeURIComponent(match[1]).split(".");
    const expected = sign(payload || "");
    if (!payload || !signature || signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.email && session.exp >= Date.now() ? session : null;
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

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function validateRecord(body) {
  const record = {
    name: cleanText(body.name, 120), category: cleanText(body.category, 80),
    kebele: cleanText(body.kebele, 100), phone: cleanText(body.phone, 40),
    status: cleanText(body.status, 40), notes: cleanText(body.notes, 1000)
  };
  if (!record.name) return { error: "Name is required." };
  if (!record.category) return { error: "Category is required." };
  if (!record.status) record.status = "Active";
  return { record };
}

app.get("/api/health", (req, res) => res.json({ ok: true, service: "SWIDS", time: new Date().toISOString() }));

app.post("/api/login", loginLimiter, async (req, res) => {
  const email = cleanText(req.body.email, 200).toLowerCase();
  if (email !== ADMIN_EMAIL.toLowerCase() || !(await bcrypt.compare(String(req.body.password || ""), ADMIN_PASSWORD_HASH))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const token = makeSessionToken(email);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `swids_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax${secure}; Path=/; Max-Age=28800`);
  res.json({ ok: true, user: { email } });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "swids_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/me", requireAuth, (req, res) => res.json({ authenticated: true, user: { email: req.user.email } }));

app.get("/api/records", requireAuth, (req, res) => {
  const q = cleanText(req.query.q, 100).toLowerCase();
  let records = readRecords();
  if (q) records = records.filter(r => [r.name, r.category, r.kebele, r.phone, r.status, r.notes].some(v => String(v || "").toLowerCase().includes(q)));
  records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json({ records });
});

app.post("/api/records", requireAuth, (req, res) => {
  const result = validateRecord(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const now = new Date().toISOString();
  const record = { id: crypto.randomUUID(), ...result.record, createdAt: now, updatedAt: now };
  const records = readRecords(); records.push(record); writeRecords(records);
  res.status(201).json({ record });
});

app.put("/api/records/:id", requireAuth, (req, res) => {
  const result = validateRecord(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const records = readRecords();
  const index = records.findIndex(r => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Record not found." });
  records[index] = { ...records[index], ...result.record, updatedAt: new Date().toISOString() };
  writeRecords(records); res.json({ record: records[index] });
});

app.delete("/api/records/:id", requireAuth, (req, res) => {
  const records = readRecords();
  const filtered = records.filter(r => r.id !== req.params.id);
  if (filtered.length === records.length) return res.status(404).json({ error: "Record not found." });
  writeRecords(filtered); res.json({ ok: true });
});

app.get("/admin_panel.html", (req, res) => res.sendFile(path.join(__dirname, "admin_panel.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin_panel.html")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "admin_panel.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
