const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const express = require("express");
const nodemailer = require("nodemailer");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 4173);
const STORE_PATH = process.env.DATA_FILE || path.join(ROOT, "data", "store.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "levadmin";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "levsincometax@gmail.com";
const EMAIL_FROM = process.env.EMAIL_FROM || `Lev's Income Tax <${ADMIN_EMAIL}>`;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const CLIENT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PRESIGN_PUT_TTL_SECONDS = 5 * 60;
const PRESIGN_GET_TTL_SECONDS = 5 * 60;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_PREFIXES = ["application/pdf", "image/", "application/vnd.openxmlformats", "application/msword", "text/"];

const app = express();
let writeQueue = Promise.resolve();

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

let r2ClientCache = null;
function getR2Client() {
  if (r2ClientCache) return r2ClientCache;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) return null;
  r2ClientCache = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
  });
  return r2ClientCache;
}

function sanitizeKeySegment(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-{2,}/g, "-").slice(0, 120);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, emailConfigured: isEmailConfigured() });
});

app.post("/api/magic-link", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }

    const result = await updateStore((store) => {
      let client = findClientByEmail(store, email);
      if (!client) {
        client = upsertClient(store, { name: fallbackNameFromEmail(email), email });
      }
      const magic = createMagicLinkRecord(store, client, getPublicBaseUrl(req));
      return { client: publicClient(client), link: magic.link };
    });

    if (result.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }

    const delivery = await sendMagicLinkEmail(result.client, result.link);
    res.json({
      ok: true,
      client: result.client,
      emailSent: delivery.sent,
      emailMode: delivery.mode,
      previewLink: delivery.previewLink ? result.link : ""
    });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.post("/api/magic-link/consume", async (req, res) => {
  try {
    const token = cleanText(req.body.token);
    if (!token) {
      res.status(400).json({ error: "Magic link token is required." });
      return;
    }

    const result = await updateStore((store) => {
      pruneStore(store);

      const tokenHash = hashToken(token);
      const record = store.magicLinks.find((item) => item.tokenHash === tokenHash);

      if (!record) {
        return { error: "Magic link was not recognized.", status: 404 };
      }

      if (record.usedAt) {
        return { error: "Magic link has already been used.", status: 410 };
      }

      if (Date.parse(record.expiresAt) <= Date.now()) {
        return { error: "Magic link has expired.", status: 410 };
      }

      const client = store.clients.find((item) => item.id === record.clientId);
      if (!client) {
        return { error: "Client account was not found for this magic link.", status: 404 };
      }

      record.usedAt = new Date().toISOString();
      const clientToken = createSession(store.clientSessions, client.id, CLIENT_SESSION_TTL_MS);
      return { client: publicClient(client), clientToken };
    });

    if (result.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }

    res.json({ ok: true, client: result.client, clientToken: result.clientToken });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.post("/api/uploads", async (req, res) => {
  try {
    const bearer = getBearerToken(req);
    const taxYear = cleanText(req.body.taxYear);
    const taxInfo = normalizeTaxInfo(req.body.taxInfo);
    const incomingDocs = Array.isArray(req.body.documents) ? req.body.documents : [];

    if (!taxYear) {
      res.status(400).json({ error: "Tax year is required." });
      return;
    }

    if (!incomingDocs.length) {
      res.status(400).json({ error: "At least one document is required." });
      return;
    }

    const result = await updateStore((store) => {
      pruneStore(store);

      const clientId = verifySession(store.clientSessions, bearer);
      if (!clientId) {
        return { error: "Upload session is missing or expired.", status: 401 };
      }

      const client = store.clients.find((item) => item.id === clientId);
      if (!client) {
        return { error: "Client account was not found.", status: 404 };
      }

      if (taxInfo) {
        client.name = taxInfo.fullName || client.name;
        client.taxInfo = taxInfo;
        client.taxInfoConfirmedAt = new Date().toISOString();
      }

      for (const doc of incomingDocs) {
        if (!cleanText(doc.key)) {
          return { error: "Each document must include an upload key.", status: 400 };
        }
      }

      const documents = incomingDocs.map((doc) => normalizeDocument(doc, taxYear));
      client.documents.push(...documents);
      client.updatedAt = new Date().toISOString();

      const alerts = createUploadAlerts(store, client, documents, taxYear);
      return { client: publicClient(client), documents, alerts };
    });

    if (result.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }

    await sendUploadNotificationEmail(result.client, result.documents, taxYear, getPublicBaseUrl(req));
    res.json({ ok: true, client: result.client, alerts: result.alerts });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.post("/api/uploads/presign", async (req, res) => {
  try {
    const bearer = getBearerToken(req);
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ error: "No files specified." });

    const client = getR2Client();
    if (!client) return res.status(503).json({ error: "Document storage is not configured. Set R2 environment variables and restart the server." });

    const store = await readStore();
    const clientId = verifySession(store.clientSessions, bearer);
    if (!clientId) return res.status(401).json({ error: "Upload session is missing or expired." });

    const uploads = [];
    for (const file of files) {
      const name = cleanText(file.name) || "document";
      const type = cleanText(file.type) || "application/octet-stream";
      const size = Number(file.size) || 0;
      if (size > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: `${name} exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit.` });
      }
      if (!ALLOWED_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) {
        return res.status(415).json({ error: `${name} is not a supported document type.` });
      }
      const key = `clients/${clientId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeKeySegment(name)}`;
      const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        ContentType: type,
        ContentLength: size
      });
      const uploadUrl = await getSignedUrl(client, command, { expiresIn: PRESIGN_PUT_TTL_SECONDS });
      uploads.push({ key, uploadUrl, headers: { "Content-Type": type } });
    }

    res.json({ ok: true, uploads });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.post("/api/admin/documents/download", async (req, res) => {
  try {
    const bearer = getBearerToken(req);
    const key = cleanText(req.body.key);
    if (!key) return res.status(400).json({ error: "Key is required." });

    const client = getR2Client();
    if (!client) return res.status(503).json({ error: "Document storage is not configured." });

    const store = await readStore();
    if (!verifySession(store.adminSessions, bearer)) return res.status(401).json({ error: "Admin session is missing or expired." });

    const exists = store.clients.some((c) => Array.isArray(c.documents) && c.documents.some((d) => d.key === key));
    if (!exists) return res.status(404).json({ error: "Document not found." });

    const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key });
    const url = await getSignedUrl(client, command, { expiresIn: PRESIGN_GET_TTL_SECONDS });
    res.json({ ok: true, url });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    if (String(req.body.password || "") !== ADMIN_PASSWORD) {
      res.status(401).json({ error: "Admin password not recognized." });
      return;
    }

    const adminToken = await updateStore((store) => {
      pruneStore(store);
      return createSession(store.adminSessions, "admin", ADMIN_SESSION_TTL_MS);
    });

    res.json({ ok: true, adminToken });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.get("/api/admin/clients", async (req, res) => {
  try {
    const store = await readStore();
    if (!verifySession(store.adminSessions, getBearerToken(req))) {
      res.status(401).json({ error: "Admin session is missing or expired." });
      return;
    }

    res.json({
      ok: true,
      clients: store.clients.map(publicClient),
      alerts: store.alerts
    });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.post("/api/admin/clients/tax-info", async (req, res) => {
  try {
    const taxInfo = normalizeTaxInfo(req.body.taxInfo);

    if (!taxInfo || !taxInfo.fullName) {
      res.status(400).json({ error: "Full legal name is required." });
      return;
    }

    const result = await updateStore((store) => {
      pruneStore(store);

      if (!verifySession(store.adminSessions, getBearerToken(req))) {
        return { error: "Admin session is missing or expired.", status: 401 };
      }

      const client = store.clients.find((item) => item.id === cleanText(req.body.clientId));
      if (!client) {
        return { error: "Client account was not found.", status: 404 };
      }

      client.name = taxInfo.fullName || client.name;
      client.taxInfo = taxInfo;
      client.updatedAt = new Date().toISOString();

      return { client: publicClient(client) };
    });

    if (result.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }

    res.json({ ok: true, client: result.client });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.post("/api/admin/alerts/seen", async (req, res) => {
  try {
    const result = await updateStore((store) => {
      pruneStore(store);

      if (!verifySession(store.adminSessions, getBearerToken(req))) {
        return { error: "Admin session is missing or expired.", status: 401 };
      }

      const clientId = cleanText(req.body.clientId);
      const now = new Date().toISOString();
      store.alerts.forEach((alert) => {
        if (!alert.seenAt && (!clientId || alert.clientId === clientId)) {
          alert.seenAt = now;
        }
      });

      return { alerts: store.alerts };
    });

    if (result.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }

    res.json({ ok: true, alerts: result.alerts });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.post("/api/admin/magic-link", async (req, res) => {
  try {
    const result = await updateStore((store) => {
      pruneStore(store);

      if (!verifySession(store.adminSessions, getBearerToken(req))) {
        return { error: "Admin session is missing or expired.", status: 401 };
      }

      const client = store.clients.find((item) => item.id === cleanText(req.body.clientId));
      if (!client) {
        return { error: "Client account was not found.", status: 404 };
      }

      const magic = createMagicLinkRecord(store, client, getPublicBaseUrl(req));
      return { client: publicClient(client), link: magic.link };
    });

    if (result.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }

    const delivery = await sendMagicLinkEmail(result.client, result.link);
    res.json({
      ok: true,
      client: result.client,
      emailSent: delivery.sent,
      emailMode: delivery.mode,
      previewLink: delivery.previewLink ? result.link : ""
    });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.get(["/admin", "/admin/"], (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.use(express.static(ROOT, { extensions: ["html"] }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Lev's Income Tax portal running at http://localhost:${PORT}`);
    if (!isEmailConfigured()) {
      console.log("Email backend is in console preview mode. Configure RESEND_API_KEY or SMTP_* env vars to send real email.");
    }
    if (!getR2Client()) {
      console.log("R2 document storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET to enable file uploads.");
    }
  });
}

module.exports = app;

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const equals = trimmed.indexOf("=");
    if (equals === -1) return;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  });
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeEmail(value) {
  const email = cleanText(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function fallbackNameFromEmail(email) {
  return email.split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Client";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createRawToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function createSession(collection, subjectId, ttlMs) {
  const token = createRawToken();
  collection.unshift({
    tokenHash: hashToken(token),
    subjectId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString()
  });
  return token;
}

function verifySession(collection, token) {
  if (!token) return "";

  const tokenHash = hashToken(token);
  const session = collection.find((item) => item.tokenHash === tokenHash);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return "";
  return session.subjectId;
}

function createMagicLinkRecord(store, client, baseUrl) {
  const token = createRawToken();
  store.magicLinks.unshift({
    tokenHash: hashToken(token),
    clientId: client.id,
    email: client.email,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString(),
    usedAt: ""
  });

  const linkUrl = new URL("/", baseUrl);
  linkUrl.searchParams.set("magic", token);
  return { link: linkUrl.toString() };
}

function getPublicBaseUrl(req) {
  return process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get("host")}`;
}

function defaultStore() {
  return {
    clients: [],
    magicLinks: [],
    clientSessions: [],
    adminSessions: [],
    alerts: []
  };
}

const STORE_R2_KEY = process.env.STORE_R2_KEY || "app-state/store.json";

async function readStore() {
  const client = getR2Client();
  if (client) {
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: STORE_R2_KEY }));
      const text = await out.Body.transformToString();
      return { ...defaultStore(), ...JSON.parse(text) };
    } catch (error) {
      if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return defaultStore();
      throw error;
    }
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(STORE_PATH, "utf8"));
    return { ...defaultStore(), ...parsed };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return defaultStore();
  }
}

async function writeStore(store) {
  const client = getR2Client();
  if (client) {
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: STORE_R2_KEY,
      Body: JSON.stringify(store, null, 2),
      ContentType: "application/json"
    }));
    return;
  }
  await fsp.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fsp.writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

function updateStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });

  return writeQueue;
}

function pruneStore(store) {
  const now = Date.now();
  store.magicLinks = store.magicLinks.filter((item) => !item.usedAt && Date.parse(item.expiresAt) > now);
  store.clientSessions = store.clientSessions.filter((item) => Date.parse(item.expiresAt) > now);
  store.adminSessions = store.adminSessions.filter((item) => Date.parse(item.expiresAt) > now);
}

function findClientByEmail(store, email) {
  return store.clients.find((client) => client.email.toLowerCase() === email.toLowerCase()) || null;
}

function upsertClient(store, { name, email }) {
  const existing = findClientByEmail(store, email);
  const now = new Date().toISOString();

  if (existing) {
    existing.name = name || existing.name;
    existing.updatedAt = now;
    return existing;
  }

  const client = {
    id: crypto.randomUUID(),
    name,
    email,
    taxInfo: null,
    taxInfoConfirmedAt: "",
    documents: [],
    createdAt: now,
    updatedAt: now
  };

  store.clients.unshift(client);
  return client;
}

function normalizeTaxInfo(value) {
  if (!value || typeof value !== "object") return null;

  return {
    fullName: cleanText(value.fullName),
    phone: cleanText(value.phone),
    street: cleanText(value.street),
    city: cleanText(value.city),
    state: cleanText(value.state).toUpperCase().slice(0, 2),
    zip: cleanText(value.zip),
    filingStatus: cleanText(value.filingStatus),
    dependents: cleanText(value.dependents || "0"),
    occupation: cleanText(value.occupation),
    incomeChanges: cleanText(value.incomeChanges),
    notes: cleanText(value.notes)
  };
}

function normalizeDocument(doc, taxYear) {
  return {
    id: crypto.randomUUID(),
    name: cleanText(doc.name) || "document",
    type: cleanText(doc.type) || "application/octet-stream",
    size: Number.isFinite(Number(doc.size)) ? Number(doc.size) : 0,
    key: cleanText(doc.key),
    taxYear,
    uploadedAt: new Date().toISOString()
  };
}

function createUploadAlerts(store, client, documents, taxYear) {
  const alerts = documents.map((doc) => ({
    id: crypto.randomUUID(),
    clientId: client.id,
    clientName: client.name,
    clientEmail: client.email,
    documentId: doc.id,
    documentName: doc.name,
    taxYear,
    uploadedAt: doc.uploadedAt,
    seenAt: ""
  }));

  store.alerts.unshift(...alerts);
  return alerts;
}

function publicClient(client) {
  return {
    id: client.id,
    name: client.name,
    email: client.email,
    taxInfo: client.taxInfo || null,
    taxInfoConfirmedAt: client.taxInfoConfirmedAt || "",
    documents: Array.isArray(client.documents) ? client.documents : [],
    createdAt: client.createdAt,
    updatedAt: client.updatedAt
  };
}

function isEmailConfigured() {
  if (process.env.EMAIL_MODE === "console") return false;
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_HOST);
}

async function sendMagicLinkEmail(client, link) {
  const subject = "Your Lev's Income Tax upload link";
  const text = [
    `Hi ${client.name},`,
    "",
    "Use this private link to confirm your tax information and upload documents:",
    link,
    "",
    "This link expires in 15 minutes.",
    "",
    "Lev's Income Tax"
  ].join("\n");
  const html = `
    <p>Hi ${escapeHtmlForEmail(client.name)},</p>
    <p>Use this private link to confirm your tax information and upload documents:</p>
    <p><a href="${escapeHtmlForEmail(link)}">Open secure upload link</a></p>
    <p>This link expires in 15 minutes.</p>
    <p>Lev's Income Tax</p>
  `;

  return sendEmail({ to: client.email, subject, text, html, previewLink: true });
}

async function sendUploadNotificationEmail(client, documents, taxYear, baseUrl) {
  if (!ADMIN_EMAIL) return { sent: false, mode: "disabled", previewLink: false };

  const adminUrl = new URL("/admin/", baseUrl).toString();
  const fileList = documents.map((doc) => `- ${doc.name} (${formatBytes(doc.size)})`).join("\n");
  const htmlList = documents
    .map((doc) => `<li>${escapeHtmlForEmail(doc.name)} (${escapeHtmlForEmail(formatBytes(doc.size))})</li>`)
    .join("");

  return sendEmail({
    to: ADMIN_EMAIL,
    subject: `New upload from ${client.name}`,
    text: [
      `${client.name} (${client.email}) uploaded ${documents.length} document${documents.length === 1 ? "" : "s"} for ${taxYear}.`,
      "",
      fileList,
      "",
      `Review uploads: ${adminUrl}`
    ].join("\n"),
    html: `
      <p><strong>${escapeHtmlForEmail(client.name)}</strong> (${escapeHtmlForEmail(client.email)}) uploaded ${documents.length} document${documents.length === 1 ? "" : "s"} for ${escapeHtmlForEmail(taxYear)}.</p>
      <ul>${htmlList}</ul>
      <p><a href="${escapeHtmlForEmail(adminUrl)}">Review uploads in the admin dashboard</a></p>
    `
  });
}

async function sendEmail({ to, subject, text, html, previewLink = false }) {
  if (process.env.EMAIL_MODE === "console") {
    return previewEmail({ to, subject, text, previewLink });
  }

  if (process.env.RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject,
        text,
        html
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend email failed: ${body}`);
    }

    return { sent: true, mode: "resend", previewLink: false };
  }

  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER || process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });

    await transporter.sendMail({ from: EMAIL_FROM, to, subject, text, html });
    return { sent: true, mode: "smtp", previewLink: false };
  }

  return previewEmail({ to, subject, text, previewLink });
}

function previewEmail({ to, subject, text, previewLink }) {
  console.log("\n--- Email preview ---");
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(text);
  console.log("--- End email preview ---\n");
  return { sent: false, mode: "console", previewLink };
}

function escapeHtmlForEmail(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function handleApiError(res, error) {
  console.error(error);
  res.status(500).json({ error: "Server error. Please try again." });
}
