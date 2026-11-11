// Mela Tickets: event ticketing for Nepal (demo only). One Cloudflare Worker over D1.
// No payment is taken anywhere in this app. Orders are free or "pending, pay at the venue".
// All seeded names, venues and events are made up.

const enc = new TextEncoder();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 symbols: no 0, O, 1, I, L
const MAX_BODY_BYTES = 16 * 1024;
const QR_PREFIX = "MELA1:";
const ROLES = ["buyer", "organiser", "door", "admin"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
     role TEXT NOT NULL CHECK (role IN ('buyer','organiser','door','admin')),
     pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY, organiser_id TEXT NOT NULL, name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '', venue TEXT NOT NULL, starts_at INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft','published','closed')),
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ticket_types (
     id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
     price_npr INTEGER NOT NULL CHECK (price_npr >= 0),
     capacity INTEGER NOT NULL CHECK (capacity >= 0),
     max_per_order INTEGER NOT NULL CHECK (max_per_order BETWEEN 1 AND 10),
     on_sale INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS event_staff (
     event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL,
     PRIMARY KEY (event_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL,
     buyer_name TEXT NOT NULL, buyer_email TEXT NOT NULL, total_npr INTEGER NOT NULL,
     payment_status TEXT NOT NULL CHECK (payment_status IN ('free','pending_offline')),
     idempotency_key TEXT, created_at INTEGER NOT NULL,
     UNIQUE (user_id, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS tickets (
     id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
     event_id TEXT NOT NULL REFERENCES events(id),
     ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
     short_code TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL CHECK (status IN ('valid','used','void')),
     used_at INTEGER, used_by TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tickets_by_event ON tickets(event_id, status)`,
  `CREATE INDEX IF NOT EXISTS tickets_by_type ON tickets(ticket_type_id, status)`,
  `CREATE INDEX IF NOT EXISTS orders_by_user ON orders(user_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target TEXT,
     detail TEXT, created_at INTEGER NOT NULL)`,
  // Capacity is a database rule, not only an app rule: a ticket row cannot be added once
  // the type already holds `capacity` non-void tickets. Writes run in one transaction per
  // order, so a failed insert rolls the whole order back.
  `CREATE TRIGGER IF NOT EXISTS tickets_capacity_guard BEFORE INSERT ON tickets
     WHEN (SELECT COUNT(*) FROM tickets t WHERE t.ticket_type_id = NEW.ticket_type_id AND t.status <> 'void')
          >= (SELECT capacity FROM ticket_types WHERE id = NEW.ticket_type_id)
   BEGIN SELECT RAISE(ABORT, 'sold_out'); END`,
  `CREATE TRIGGER IF NOT EXISTS tickets_type_matches_event BEFORE INSERT ON tickets
     WHEN (SELECT event_id FROM ticket_types WHERE id = NEW.ticket_type_id) <> NEW.event_id
   BEGIN SELECT RAISE(ABORT, 'type_event_mismatch'); END`,
  `CREATE TRIGGER IF NOT EXISTS ticket_types_capacity_floor BEFORE UPDATE OF capacity ON ticket_types
     WHEN NEW.capacity < (SELECT COUNT(*) FROM tickets t WHERE t.ticket_type_id = NEW.id AND t.status <> 'void')
   BEGIN SELECT RAISE(ABORT, 'capacity_below_sold'); END`,
];

// Demo seed. Names, venues and events are invented. Password hashes are precomputed so the
// first request does not spend CPU on PBKDF2. The demo passwords are printed on the login page.
const DEMO = {
  users: [
    { id: "demo-buyer", name: "Ritu Demo", email: "buyer@demo.melatickets.example", role: "buyer",
      hash: "pbkdf2-sha256$100000$Txb3EraXfGg3Ki-v7_SZpA$se1oXG06qyyDkLZptGDabd9AGz-5YPKESfCpM5V0f1k" },
    { id: "demo-organiser", name: "Sanjay Demo", email: "organiser@demo.melatickets.example", role: "organiser",
      hash: "pbkdf2-sha256$100000$gAU8ZCEzXBJdOYeiX3NOTA$T-3jGPrmRwMLBQR0oD7xSjqvcnBPewxocGfhwLCUwm8" },
    { id: "demo-door", name: "Gate Demo", email: "door@demo.melatickets.example", role: "door",
      hash: "pbkdf2-sha256$100000$xGH8GANk8yXzONMuaFOcrg$FLByOdzV4dS9w7954SRWrMCr71lUFIvZmI1IUpq7vHg" },
    { id: "demo-admin", name: "Admin Demo", email: "admin@demo.melatickets.example", role: "admin",
      hash: "pbkdf2-sha256$100000$dWpsS9MH8SeAUn20GbhDug$ZZoB0zFk6w5i906jCvfrCWWX6bx2Oh-2xCIA1V3A6bA" },
  ],
};

// ---------- small helpers ----------
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });
const fail = (status, error, message) => json({ error, message }, status);
const now = () => Date.now();
const newId = () => crypto.randomUUID();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(name, value, { maxAge, sameSite = "Lax" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}
function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function shortCode() {
  // 31 symbols: take bytes below 248 (= 31 * 8) and map by modulo, so every symbol is equally likely.
  let s = "";
  while (s.length < 8) {
    const b = randomBytes(1)[0];
    if (b < 248) s += CODE_ALPHABET[b % 31];
  }
  return s;
}
function normalizeCode(raw) {
  let s = String(raw || "").trim().toUpperCase();
  if (s.startsWith(QR_PREFIX)) s = s.slice(QR_PREFIX.length);
  return s.replace(/[\s-]/g, "");
}
function formatCode(code) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

// ---------- passwords (PBKDF2-SHA256, WebCrypto) ----------
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  const salt = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const expected = parts[3];
  const hash = await pbkdf2(password, salt, iterations);
  return safeEqual(b64url(hash), expected);
}

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
function cleanText(v, max, min = 1) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length >= min && s.length <= max ? s : null;
}
function cleanInt(v, min, max) {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
// The browser sends "YYYY-MM-DDTHH:MM" meaning Nepal Time (UTC+05:45). Nepal has no DST.
function parseNptLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+05:45`);
  return Number.isNaN(ms) ? null : ms;
}
const EVENT_STATUSES = ["draft", "published", "closed"];

async function readJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) return { tooBig: true };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { tooBig: true };
  if (!text) return { body: {} };
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? { body } : { bad: true };
  } catch {
    return { bad: true };
  }
}

// ---------- database setup ----------
const dbReady = new WeakMap(); // keyed by the D1 binding, so every database is set up once
async function ensureDb(env) {
  if (!dbReady.has(env.DB)) {
    const p = (async () => {
      for (const stmt of SCHEMA) await env.DB.prepare(stmt).run();
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
      if (Number(row.n) === 0) await seedDemo(env);
    })().catch((e) => {
      dbReady.delete(env.DB);
      throw e;
    });
    dbReady.set(env.DB, p);
  }
  return dbReady.get(env.DB);
}
async function seedDemo(env) {
  const t = now();
  const stmts = [];
  for (const u of DEMO.users) {
    stmts.push(env.DB.prepare("INSERT INTO users (id,name,email,role,pw_hash,created_at) VALUES (?,?,?,?,?,?)")
      .bind(u.id, u.name, u.email, u.role, u.hash, t));
  }
  const events = [
    { id: "demo-lantern", name: "Lantern Night Fair (DEMO)", description: "A made-up evening fair in a made-up courtyard. Demo data only.",
      venue: "Demo Courtyard, Example Road, Inaruwa (not a real venue)", starts_at: parseNptLocal("2026-12-05T18:00"), status: "published" },
    { id: "demo-poetry", name: "Open Mic Poetry Hour (DEMO)", description: "Invented poetry evening. Free entry in the demo.",
      venue: "Demo Library Room, Sample Chowk (not a real venue)", starts_at: parseNptLocal("2026-12-12T16:30"), status: "published" },
    { id: "demo-draft", name: "Harvest Sale Planning (DEMO draft)", description: "Draft event, not visible to buyers.",
      venue: "Demo Hall (not a real venue)", starts_at: parseNptLocal("2027-01-10T10:00"), status: "draft" },
  ];
  for (const e of events) {
    stmts.push(env.DB.prepare("INSERT INTO events (id,organiser_id,name,description,venue,starts_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(e.id, "demo-organiser", e.name, e.description, e.venue, e.starts_at, e.status, t, t));
  }
  const types = [
    ["demo-lantern-gen", "demo-lantern", "General (demo price)", 300, 120, 6],
    ["demo-lantern-family", "demo-lantern", "Family pass (demo price)", 800, 30, 4],
    ["demo-lantern-helper", "demo-lantern", "Stall helper (free)", 0, 10, 1],
    ["demo-poetry-open", "demo-poetry", "Open seat (free)", 0, 25, 4],
    ["demo-draft-gen", "demo-draft", "General (free)", 0, 50, 4],
  ];
  for (const [id, eventId, name, price, cap, max] of types) {
    stmts.push(env.DB.prepare("INSERT INTO ticket_types (id,event_id,name,price_npr,capacity,max_per_order,on_sale,created_at) VALUES (?,?,?,?,?,?,1,?)")
      .bind(id, eventId, name, price, cap, max, t));
  }
  stmts.push(env.DB.prepare("INSERT INTO event_staff (event_id,user_id) VALUES ('demo-lantern','demo-door')"));
  // One demo order with two tickets so the ticket page and the door check-in have something to read.
  stmts.push(env.DB.prepare("INSERT INTO orders (id,event_id,user_id,buyer_name,buyer_email,total_npr,payment_status,idempotency_key,created_at) VALUES ('demo-order-1','demo-lantern','demo-buyer','Ritu Demo','buyer@demo.melatickets.example',600,'pending_offline',NULL,?)")
    .bind(t));
  stmts.push(env.DB.prepare("INSERT INTO tickets (id,order_id,event_id,ticket_type_id,short_code,status,created_at) VALUES ('demo-ticket-1','demo-order-1','demo-lantern','demo-lantern-gen','7KQ4M9TR','valid',?)").bind(t));
  stmts.push(env.DB.prepare("INSERT INTO tickets (id,order_id,event_id,ticket_type_id,short_code,status,created_at) VALUES ('demo-ticket-2','demo-order-1','demo-lantern','demo-lantern-gen','H3PX6WNB','valid',?)").bind(t));
  await env.DB.batch(stmts);
}

// ---------- rate limits (counts in D1; window resets after the period) ----------
async function rateHit(env, key, limit, windowMs) {
  const t = now();
  const row = await env.DB.prepare("SELECT count, window_start FROM rate_limits WHERE key = ?").bind(key).first();
  if (!row || t - Number(row.window_start) >= windowMs) {
    await env.DB.prepare("INSERT INTO rate_limits (key,count,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start")
      .bind(key, t).run();
    return true;
  }
  if (Number(row.count) >= limit) return false;
  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
  return true;
}
async function rateClear(env, key) {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key).run();
}
async function rateBlocked(env, key, limit, windowMs) {
  const row = await env.DB.prepare("SELECT count, window_start FROM rate_limits WHERE key = ?").bind(key).first();
  return !!row && now() - Number(row.window_start) < windowMs && Number(row.count) >= limit;
}

// ---------- sessions and access ----------
async function currentUser(request, env) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies.mt_session;
  if (!token || token.length < 20) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT u.id, u.name, u.email, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
  ).bind(tokenHash).first();
  if (!row) return null;
  if (Number(row.expires_at) <= now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}
async function createSession(env, userId) {
  const token = b64url(randomBytes(32));
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)")
    .bind(await sha256Hex(token), userId, t, t + SESSION_TTL_MS).run();
  return token;
}
async function audit(env, actorId, action, target, detail) {
  await env.DB.prepare("INSERT INTO audit_log (id,actor_id,action,target,detail,created_at) VALUES (?,?,?,?,?,?)")
    .bind(newId(), actorId || null, action, target || null, detail ? JSON.stringify(detail) : null, now()).run();
}
const isOwnerOrAdmin = (user, event) => user.role === "admin" || (user.role === "organiser" && event.organiser_id === user.id);
async function canWorkDoor(env, user, eventId) {
  if (user.role === "admin") return true;
  const ev = await env.DB.prepare("SELECT organiser_id FROM events WHERE id = ?").bind(eventId).first();
  if (!ev) return false;
  if (user.role === "organiser" && ev.organiser_id === user.id) return true;
  if (user.role !== "door") return false;
  const staff = await env.DB.prepare("SELECT 1 AS ok FROM event_staff WHERE event_id = ? AND user_id = ?").bind(eventId, user.id).first();
  return !!staff;
}

// ---------- CSRF: double-submit cookie + Origin check on every POST ----------
function csrfOk(request, cookies) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  const header = request.headers.get("x-csrf-token");
  return !!header && !!cookies.mt_csrf && cookies.mt_csrf.length >= 32 && safeEqual(header, cookies.mt_csrf);
}

// ---------- event shaping ----------
async function eventWithTypes(env, row) {
  const types = await env.DB.prepare(
    `SELECT tt.id, tt.name, tt.price_npr, tt.capacity, tt.max_per_order, tt.on_sale,
            (SELECT COUNT(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status <> 'void') AS issued
       FROM ticket_types tt WHERE tt.event_id = ? ORDER BY tt.price_npr, tt.name`,
  ).bind(row.id).all();
  return {
    id: row.id, name: row.name, description: row.description, venue: row.venue,
    starts_at: Number(row.starts_at), status: row.status, organiser_id: row.organiser_id,
    ticket_types: (types.results || []).map((t) => ({
      id: t.id, name: t.name, price_npr: Number(t.price_npr), capacity: Number(t.capacity),
      max_per_order: Number(t.max_per_order), on_sale: !!t.on_sale,
      remaining: Math.max(0, Number(t.capacity) - Number(t.issued)),
    })),
  };
}

// ---------- routes ----------
async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const cookies = parseCookies(request.headers.get("cookie"));
  const ip = request.headers.get("cf-connecting-ip") || "local";

  if (method === "GET" && path === "/api/session") {
    const user = await currentUser(request, env);
    let csrf = cookies.mt_csrf;
    const headers = {};
    if (!csrf || csrf.length < 32) {
      csrf = b64url(randomBytes(32));
      headers["set-cookie"] = setCookie("mt_csrf", csrf, { sameSite: "Strict" });
    }
    return json({ user, csrf }, 200, headers);
  }

  if (method === "GET" && path === "/api/events") {
    const rows = await env.DB.prepare("SELECT * FROM events WHERE status = 'published' ORDER BY starts_at").all();
    const out = [];
    for (const r of rows.results || []) out.push(await eventWithTypes(env, r));
    return json({ events: out });
  }

  const eventMatch = /^\/api\/events\/([\w-]{1,64})$/.exec(path);
  if (method === "GET" && eventMatch) {
    const row = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventMatch[1]).first();
    if (!row) return fail(404, "not_found", "No such event.");
    if (row.status !== "published") {
      const user = await currentUser(request, env);
      if (!user || !isOwnerOrAdmin(user, row)) return fail(404, "not_found", "No such event.");
    }
    return json({ event: await eventWithTypes(env, row) });
  }

  // Everything below here is a POST, PUT or read that needs a session.
  if (method === "POST" || method === "PUT") {
    if (!csrfOk(request, cookies)) return fail(403, "csrf", "The form expired. Reload the page and try again.");
  }

  if (method === "POST" && path === "/api/auth/register") {
    if (!(await rateHit(env, `reg:${ip}`, 10, 60 * 60 * 1000))) return fail(429, "rate_limited", "Too many sign-ups from here. Try again later.");
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
    const name = cleanText(body.name, 60, 2);
    const email = cleanText(body.email, 254, 5)?.toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!name) return fail(422, "invalid_name", "Enter your name (2 to 60 characters).");
    if (!email || !EMAIL_RE.test(email)) return fail(422, "invalid_email", "Enter a valid email address.");
    if (password.length < 10 || password.length > 128) return fail(422, "invalid_password", "Use a password of 10 to 128 characters.");
    const role = body.organiser === true ? "organiser" : "buyer";
    const exists = await env.DB.prepare("SELECT 1 AS ok FROM users WHERE email = ?").bind(email).first();
    if (exists) return fail(409, "email_taken", "An account already uses this email. Log in instead.");
    const id = newId();
    await env.DB.prepare("INSERT INTO users (id,name,email,role,pw_hash,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, name, email, role, await hashPassword(password), now()).run();
    const token = await createSession(env, id);
    return json({ user: { id, name, email, role } }, 201, { "set-cookie": setCookie("mt_session", token, { maxAge: SESSION_TTL_MS / 1000 }) });
  }

  if (method === "POST" && path === "/api/auth/login") {
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
    const email = cleanText(body.email, 254, 3)?.toLowerCase() || "";
    const password = typeof body.password === "string" ? body.password : "";
    const keyEmail = `login-email:${email}`;
    const keyIp = `login-ip:${ip}`;
    if ((await rateBlocked(env, keyEmail, 5, 15 * 60 * 1000)) || (await rateBlocked(env, keyIp, 30, 15 * 60 * 1000))) {
      return fail(429, "rate_limited", "Too many failed log-ins. Wait 15 minutes and try again.");
    }
    const row = await env.DB.prepare("SELECT id, name, email, role, pw_hash FROM users WHERE email = ?").bind(email).first();
    // Always run one verification so a missing account does not answer faster than a wrong password.
    const ok = await verifyPassword(password, row ? row.pw_hash : "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    if (!row || !ok) {
      await rateHit(env, keyEmail, 5, 15 * 60 * 1000);
      await rateHit(env, keyIp, 30, 15 * 60 * 1000);
      return fail(401, "bad_login", "Email or password is not right.");
    }
    await rateClear(env, keyEmail);
    const token = await createSession(env, row.id);
    return json({ user: { id: row.id, name: row.name, email: row.email, role: row.role } }, 200,
      { "set-cookie": setCookie("mt_session", token, { maxAge: SESSION_TTL_MS / 1000 }) });
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = cookies.mt_session;
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
    return json({ ok: true }, 200, { "set-cookie": setCookie("mt_session", "", { maxAge: 0 }) });
  }

  if (!path.startsWith("/api/")) return fail(404, "not_found", "No such page.");

  const user = await currentUser(request, env);
  if (!user) return fail(401, "login_required", "Log in to continue.");

  // ----- buying -----
  if (method === "POST" && path === "/api/orders") {
    if (user.role === "door") return fail(403, "forbidden", "Door staff accounts cannot buy tickets.");
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the order.");
    const eventRow = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(String(body.event_id || "")).first();
    if (!eventRow || eventRow.status !== "published") return fail(404, "not_found", "That event is not on sale.");
    const buyerName = cleanText(body.buyer_name, 60, 2);
    const buyerEmail = cleanText(body.buyer_email, 254, 5)?.toLowerCase();
    if (!buyerName) return fail(422, "invalid_name", "Enter the name the ticket is for.");
    if (!buyerEmail || !EMAIL_RE.test(buyerEmail)) return fail(422, "invalid_email", "Enter a valid email address.");
    const idempotencyKey = cleanText(body.idempotency_key, 64, 8);
    if (!idempotencyKey) return fail(400, "bad_request", "Missing order key. Reload the page.");
    // Same form submitted twice (double tap, retry): return the first order, create nothing.
    const prior = await env.DB.prepare("SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?").bind(user.id, idempotencyKey).first();
    if (prior) return json({ order_id: prior.id, duplicate: true }, 200);
    if (!Array.isArray(body.items) || body.items.length === 0) return fail(422, "invalid_items", "Choose at least one ticket.");
    if (!(await rateHit(env, `order:${user.id}`, 20, 60 * 60 * 1000))) return fail(429, "rate_limited", "Too many orders in the last hour. Try again later.");

    const lines = [];
    const typeIds = new Set();
    for (const item of body.items) {
      const qty = cleanInt(item && item.quantity, 0, 10);
      if (qty === null) return fail(422, "invalid_quantity", "Quantities must be whole numbers from 0 to 10.");
      if (qty === 0) continue;
      const typeId = String(item.ticket_type_id || "");
      if (typeIds.has(typeId)) return fail(422, "invalid_items", "Each ticket type can appear once in an order.");
      typeIds.add(typeId);
      const tt = await env.DB.prepare("SELECT * FROM ticket_types WHERE id = ? AND event_id = ?").bind(typeId, eventRow.id).first();
      if (!tt) return fail(422, "invalid_items", "One of the ticket types is not part of this event.");
      if (!tt.on_sale) return fail(409, "not_on_sale", `${tt.name} is not on sale.`);
      if (qty > Number(tt.max_per_order)) return fail(422, "over_limit", `You can buy up to ${tt.max_per_order} of ${tt.name} per order.`);
      lines.push({ tt, qty });
    }
    const totalQty = lines.reduce((s, l) => s + l.qty, 0);
    if (totalQty === 0) return fail(422, "invalid_items", "Choose at least one ticket.");
    if (totalQty > 10) return fail(422, "over_limit", "An order can hold up to 10 tickets.");
    const total = lines.reduce((s, l) => s + Number(l.tt.price_npr) * l.qty, 0);
    const paymentStatus = total === 0 ? "free" : "pending_offline";
    const orderId = newId();

    for (let attempt = 0; attempt < 3; attempt++) {
      const stmts = [env.DB.prepare(
        "INSERT INTO orders (id,event_id,user_id,buyer_name,buyer_email,total_npr,payment_status,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(orderId, eventRow.id, user.id, buyerName, buyerEmail, total, paymentStatus, idempotencyKey, now())];
      for (const l of lines) {
        for (let i = 0; i < l.qty; i++) {
          stmts.push(env.DB.prepare(
            "INSERT INTO tickets (id,order_id,event_id,ticket_type_id,short_code,status,created_at) VALUES (?,?,?,?,?,'valid',?)",
          ).bind(newId(), orderId, eventRow.id, l.tt.id, shortCode(), now()));
        }
      }
      try {
        // D1 batch = one transaction: any sold_out abort rolls the order and every ticket back.
        await env.DB.batch(stmts);
        await audit(env, user.id, "order.create", orderId, { event: eventRow.id, tickets: totalQty, total });
        return json({ order_id: orderId, duplicate: false }, 201);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg.includes("sold_out")) return fail(409, "sold_out", "Those tickets just sold out. Pick again.");
        if (msg.includes("UNIQUE") && msg.includes("idempotency")) {
          const again = await env.DB.prepare("SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?").bind(user.id, idempotencyKey).first();
          if (again) return json({ order_id: again.id, duplicate: true }, 200);
        }
        if (msg.includes("UNIQUE") && msg.includes("short_code")) continue; // new codes on retry
        if (msg.includes("capacity") || msg.includes("type_event_mismatch")) return fail(409, "sold_out", "Those tickets just sold out. Pick again.");
        throw e;
      }
    }
    return fail(500, "order_failed", "The order did not go through. Nothing was reserved. Try again.");
  }

  if (method === "GET" && path === "/api/orders") {
    const rows = await env.DB.prepare(
      `SELECT o.id, o.total_npr, o.payment_status, o.created_at, e.name AS event_name, e.starts_at,
              (SELECT COUNT(*) FROM tickets t WHERE t.order_id = o.id AND t.status <> 'void') AS tickets
         FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = ? ORDER BY o.created_at DESC`,
    ).bind(user.id).all();
    return json({ orders: rows.results || [] });
  }

  const orderMatch = /^\/api\/orders\/([\w-]{1,64})$/.exec(path);
  if (method === "GET" && orderMatch) {
    const o = await env.DB.prepare(
      `SELECT o.*, e.name AS event_name, e.venue, e.starts_at, e.organiser_id FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = ?`,
    ).bind(orderMatch[1]).first();
    if (!o) return fail(404, "not_found", "No such order.");
    const allowed = o.user_id === user.id || user.role === "admin" || (user.role === "organiser" && o.organiser_id === user.id);
    if (!allowed) return fail(404, "not_found", "No such order."); // 404, not 403: do not reveal other people's orders
    const tickets = await env.DB.prepare(
      `SELECT t.id, t.short_code, t.status, t.used_at, tt.name AS type_name, tt.price_npr
         FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.order_id = ? ORDER BY tt.price_npr, t.short_code`,
    ).bind(o.id).all();
    return json({
      order: {
        id: o.id, event_id: o.event_id, event_name: o.event_name, venue: o.venue, starts_at: Number(o.starts_at),
        buyer_name: o.buyer_name, buyer_email: o.buyer_email, total_npr: Number(o.total_npr),
        payment_status: o.payment_status, created_at: Number(o.created_at),
        tickets: (tickets.results || []).map((t) => ({ id: t.id, code: formatCode(t.short_code), qr: QR_PREFIX + t.short_code, status: t.status, used_at: t.used_at ? Number(t.used_at) : null, type_name: t.type_name, price_npr: Number(t.price_npr) })),
      },
    });
  }

  // ----- organiser -----
  if (path === "/api/organiser/events" && method === "GET") {
    if (!["organiser", "admin"].includes(user.role)) return fail(403, "forbidden", "Organiser accounts only.");
    const rows = user.role === "admin"
      ? await env.DB.prepare("SELECT * FROM events ORDER BY starts_at DESC").all()
      : await env.DB.prepare("SELECT * FROM events WHERE organiser_id = ? ORDER BY starts_at DESC").bind(user.id).all();
    const out = [];
    for (const r of rows.results || []) out.push(await eventWithTypes(env, r));
    return json({ events: out });
  }
  if (path === "/api/organiser/events" && method === "POST") {
    if (!["organiser", "admin"].includes(user.role)) return fail(403, "forbidden", "Organiser accounts only.");
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
    const name = cleanText(body.name, 100, 3);
    const venue = cleanText(body.venue, 160, 3);
    const description = cleanText(body.description, 1000, 0) ?? "";
    const startsAt = parseNptLocal(body.starts_at);
    const status = EVENT_STATUSES.includes(body.status) ? body.status : "draft";
    if (!name) return fail(422, "invalid_name", "Give the event a name (3 to 100 characters).");
    if (!venue) return fail(422, "invalid_venue", "Enter the venue (3 to 160 characters).");
    if (startsAt === null) return fail(422, "invalid_date", "Pick a date and time (Nepal Time).");
    const id = newId();
    const t = now();
    await env.DB.prepare("INSERT INTO events (id,organiser_id,name,description,venue,starts_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, user.id, name, description, venue, startsAt, status, t, t).run();
    await audit(env, user.id, "event.create", id, { status });
    return json({ event_id: id }, 201);
  }

  const orgEvent = /^\/api\/organiser\/events\/([\w-]{1,64})$/.exec(path);
  if (orgEvent && method === "GET") {
    const ev = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(orgEvent[1]).first();
    if (!ev || !isOwnerOrAdmin(user, ev)) return fail(404, "not_found", "No such event.");
    const detail = await eventWithTypes(env, ev);
    const staff = await env.DB.prepare("SELECT u.id, u.name, u.email FROM event_staff s JOIN users u ON u.id = s.user_id WHERE s.event_id = ? ORDER BY u.name").bind(ev.id).all();
    const orders = await env.DB.prepare(
      `SELECT o.id, o.buyer_name, o.buyer_email, o.total_npr, o.payment_status, o.created_at,
              (SELECT COUNT(*) FROM tickets t WHERE t.order_id = o.id AND t.status <> 'void') AS tickets,
              (SELECT COUNT(*) FROM tickets t WHERE t.order_id = o.id AND t.status = 'used') AS used
         FROM orders o WHERE o.event_id = ? ORDER BY o.created_at DESC LIMIT 200`,
    ).bind(ev.id).all();
    const checkedIn = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE event_id = ? AND status = 'used'").bind(ev.id).first();
    return json({ event: detail, staff: staff.results || [], orders: orders.results || [], checked_in: Number(checkedIn.n) });
  }
  if (orgEvent && method === "PUT") {
    const ev = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(orgEvent[1]).first();
    if (!ev || !isOwnerOrAdmin(user, ev)) return fail(404, "not_found", "No such event.");
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
    const name = body.name === undefined ? ev.name : cleanText(body.name, 100, 3);
    const venue = body.venue === undefined ? ev.venue : cleanText(body.venue, 160, 3);
    const description = body.description === undefined ? ev.description : (cleanText(body.description, 1000, 0) ?? "");
    const startsAt = body.starts_at === undefined ? Number(ev.starts_at) : parseNptLocal(body.starts_at);
    const status = body.status === undefined ? ev.status : (EVENT_STATUSES.includes(body.status) ? body.status : null);
    if (!name) return fail(422, "invalid_name", "Give the event a name (3 to 100 characters).");
    if (!venue) return fail(422, "invalid_venue", "Enter the venue (3 to 160 characters).");
    if (startsAt === null) return fail(422, "invalid_date", "Pick a date and time (Nepal Time).");
    if (status === null) return fail(422, "invalid_status", "Unknown event status.");
    await env.DB.prepare("UPDATE events SET name = ?, description = ?, venue = ?, starts_at = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(name, description, venue, startsAt, status, now(), ev.id).run();
    if (status !== ev.status) await audit(env, user.id, "event.status", ev.id, { from: ev.status, to: status });
    return json({ ok: true });
  }

  const orgTypes = /^\/api\/organiser\/events\/([\w-]{1,64})\/ticket-types$/.exec(path);
  if (orgTypes && method === "POST") {
    const ev = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(orgTypes[1]).first();
    if (!ev || !isOwnerOrAdmin(user, ev)) return fail(404, "not_found", "No such event.");
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
    const name = cleanText(body.name, 60, 2);
    const price = cleanInt(body.price_npr, 0, 1000000);
    const capacity = cleanInt(body.capacity, 1, 100000);
    const max = cleanInt(body.max_per_order, 1, 10);
    if (!name) return fail(422, "invalid_name", "Name the ticket type (2 to 60 characters).");
    if (price === null) return fail(422, "invalid_price", "Price in NPR, whole number, 0 for free.");
    if (capacity === null) return fail(422, "invalid_capacity", "Capacity: a whole number from 1 to 100000.");
    if (max === null) return fail(422, "invalid_limit", "Per-order limit: 1 to 10.");
    const id = newId();
    await env.DB.prepare("INSERT INTO ticket_types (id,event_id,name,price_npr,capacity,max_per_order,on_sale,created_at) VALUES (?,?,?,?,?,?,1,?)")
      .bind(id, ev.id, name, price, capacity, max, now()).run();
    await audit(env, user.id, "ticket_type.create", id, { event: ev.id, capacity });
    return json({ ticket_type_id: id }, 201);
  }

  const tt = /^\/api\/organiser\/ticket-types\/([\w-]{1,64})$/.exec(path);
  if (tt && method === "PUT") {
    const row = await env.DB.prepare("SELECT tt.*, e.organiser_id FROM ticket_types tt JOIN events e ON e.id = tt.event_id WHERE tt.id = ?").bind(tt[1]).first();
    if (!row || !isOwnerOrAdmin(user, { organiser_id: row.organiser_id })) return fail(404, "not_found", "No such ticket type.");
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
    const name = body.name === undefined ? row.name : cleanText(body.name, 60, 2);
    const price = body.price_npr === undefined ? Number(row.price_npr) : cleanInt(body.price_npr, 0, 1000000);
    const capacity = body.capacity === undefined ? Number(row.capacity) : cleanInt(body.capacity, 0, 100000);
    const max = body.max_per_order === undefined ? Number(row.max_per_order) : cleanInt(body.max_per_order, 1, 10);
    const onSale = body.on_sale === undefined ? !!row.on_sale : body.on_sale === true;
    if (!name) return fail(422, "invalid_name", "Name the ticket type (2 to 60 characters).");
    if (price === null) return fail(422, "invalid_price", "Price in NPR, whole number, 0 for free.");
    if (capacity === null) return fail(422, "invalid_capacity", "Capacity: a whole number from 0 to 100000.");
    if (max === null) return fail(422, "invalid_limit", "Per-order limit: 1 to 10.");
    try {
      await env.DB.prepare("UPDATE ticket_types SET name = ?, price_npr = ?, capacity = ?, max_per_order = ?, on_sale = ? WHERE id = ?")
        .bind(name, price, capacity, max, onSale ? 1 : 0, row.id).run();
    } catch (e) {
      if (String(e.message || e).includes("capacity_below_sold")) return fail(409, "capacity_below_sold", "Capacity cannot be lower than the tickets already issued.");
      throw e;
    }
    return json({ ok: true });
  }

  const staffRoute = /^\/api\/organiser\/events\/([\w-]{1,64})\/staff$/.exec(path);
  if (staffRoute && method === "POST") {
    const ev = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(staffRoute[1]).first();
    if (!ev || !isOwnerOrAdmin(user, ev)) return fail(404, "not_found", "No such event.");
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
    const email = cleanText(body.email, 254, 5)?.toLowerCase();
    const person = email ? await env.DB.prepare("SELECT id, name, role FROM users WHERE email = ?").bind(email).first() : null;
    if (!person || person.role !== "door") return fail(404, "no_door_account", "No door staff account uses that email. The admin creates door accounts.");
    await env.DB.prepare("INSERT OR IGNORE INTO event_staff (event_id, user_id) VALUES (?, ?)").bind(ev.id, person.id).run();
    await audit(env, user.id, "staff.add", ev.id, { user: person.id });
    return json({ ok: true }, 201);
  }
  const staffRemove = /^\/api\/organiser\/events\/([\w-]{1,64})\/staff\/remove$/.exec(path);
  if (staffRemove && method === "POST") {
    const ev = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(staffRemove[1]).first();
    if (!ev || !isOwnerOrAdmin(user, ev)) return fail(404, "not_found", "No such event.");
    const { body } = await readJson(request);
    await env.DB.prepare("DELETE FROM event_staff WHERE event_id = ? AND user_id = ?").bind(ev.id, String(body.user_id || "")).run();
    await audit(env, user.id, "staff.remove", ev.id, { user: String(body.user_id || "") });
    return json({ ok: true });
  }

  // ----- door -----
  if (path === "/api/door/events" && method === "GET") {
    let rows;
    if (user.role === "admin") rows = await env.DB.prepare("SELECT * FROM events WHERE status <> 'draft' ORDER BY starts_at").all();
    else if (user.role === "organiser") rows = await env.DB.prepare("SELECT * FROM events WHERE organiser_id = ? ORDER BY starts_at").bind(user.id).all();
    else if (user.role === "door") rows = await env.DB.prepare(
      "SELECT e.* FROM events e JOIN event_staff s ON s.event_id = e.id WHERE s.user_id = ? AND e.status <> 'draft' ORDER BY e.starts_at").bind(user.id).all();
    else return fail(403, "forbidden", "Door staff only.");
    return json({ events: (rows.results || []).map((r) => ({ id: r.id, name: r.name, venue: r.venue, starts_at: Number(r.starts_at), status: r.status })) });
  }

  const doorEvent = /^\/api\/door\/events\/([\w-]{1,64})$/.exec(path);
  if (doorEvent && method === "GET") {
    if (!(await canWorkDoor(env, user, doorEvent[1]))) return fail(403, "forbidden", "You are not on the door team for this event.");
    const ev = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(doorEvent[1]).first();
    if (!ev) return fail(404, "not_found", "No such event.");
    const types = await env.DB.prepare(
      `SELECT tt.name, tt.capacity,
              (SELECT COUNT(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status <> 'void') AS issued,
              (SELECT COUNT(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status = 'used') AS used
         FROM ticket_types tt WHERE tt.event_id = ? ORDER BY tt.price_npr, tt.name`,
    ).bind(ev.id).all();
    const recent = await env.DB.prepare(
      `SELECT t.short_code, t.used_at, o.buyer_name, tt.name AS type_name FROM tickets t
         JOIN orders o ON o.id = t.order_id JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE t.event_id = ? AND t.status = 'used' ORDER BY t.used_at DESC LIMIT 12`,
    ).bind(ev.id).all();
    return json({
      event: { id: ev.id, name: ev.name, venue: ev.venue, starts_at: Number(ev.starts_at), status: ev.status },
      types: (types.results || []).map((t) => ({ name: t.name, capacity: Number(t.capacity), issued: Number(t.issued), used: Number(t.used) })),
      recent: (recent.results || []).map((r) => ({ code: formatCode(r.short_code), buyer_name: r.buyer_name, type_name: r.type_name, used_at: Number(r.used_at) })),
    });
  }

  if (path === "/api/door/checkin" && method === "POST") {
    const { body, bad, tooBig } = await readJson(request);
    if (tooBig || bad) return fail(400, "bad_request", "Could not read the check-in.");
    const eventId = String(body.event_id || "");
    if (!(await canWorkDoor(env, user, eventId))) return fail(403, "forbidden", "You are not on the door team for this event.");
    const code = normalizeCode(body.code);
    if (!/^[A-Z2-9]{8}$/.test(code)) return fail(422, "bad_code", "Codes are 8 characters, for example 7KQ4-M9TR.");
    const t = await env.DB.prepare(
      `SELECT t.id, t.event_id, t.status, t.used_at, t.short_code, o.buyer_name, tt.name AS type_name
         FROM tickets t JOIN orders o ON o.id = t.order_id JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE t.short_code = ?`,
    ).bind(code).first();
    if (!t) return json({ result: "not_found", message: "No ticket has that code." }, 200);
    if (t.event_id !== eventId) return json({ result: "wrong_event", message: "This ticket is for a different event." }, 200);
    const stamp = now();
    // One conditional UPDATE: only a valid ticket can change, so two scans cannot both succeed.
    const upd = await env.DB.prepare("UPDATE tickets SET status = 'used', used_at = ?, used_by = ? WHERE id = ? AND status = 'valid'")
      .bind(stamp, user.id, t.id).run();
    if (upd.meta && upd.meta.changes === 1) {
      await audit(env, user.id, "checkin", t.id, { event: eventId });
      return json({ result: "valid", message: "Let them in.", ticket: { code: formatCode(t.short_code), buyer_name: t.buyer_name, type_name: t.type_name } });
    }
    const now2 = await env.DB.prepare("SELECT status, used_at FROM tickets WHERE id = ?").bind(t.id).first();
    if (now2 && now2.status === "used") {
      return json({ result: "already_used", message: "Already checked in. Do not let this one in.", used_at: Number(now2.used_at) }, 200);
    }
    return json({ result: "void", message: "This ticket was cancelled." }, 200);
  }

  // ----- admin -----
  if (path.startsWith("/api/admin/")) {
    if (user.role !== "admin") return fail(403, "forbidden", "Admin accounts only.");
    if (path === "/api/admin/overview" && method === "GET") {
      const roles = await env.DB.prepare("SELECT role, COUNT(*) AS n FROM users GROUP BY role").all();
      const ev = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM events GROUP BY status").all();
      const tk = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status").all();
      const orders = await env.DB.prepare("SELECT payment_status, COUNT(*) AS n, COALESCE(SUM(total_npr),0) AS total FROM orders GROUP BY payment_status").all();
      return json({ roles: roles.results, events: ev.results, tickets: tk.results, orders: orders.results });
    }
    if (path === "/api/admin/users" && method === "GET") {
      const rows = await env.DB.prepare("SELECT id, name, email, role, created_at FROM users ORDER BY created_at").all();
      return json({ users: rows.results });
    }
    if (path === "/api/admin/users" && method === "POST") {
      const { body, bad, tooBig } = await readJson(request);
      if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
      const name = cleanText(body.name, 60, 2);
      const email = cleanText(body.email, 254, 5)?.toLowerCase();
      const role = ROLES.includes(body.role) ? body.role : null;
      const password = typeof body.password === "string" ? body.password : "";
      if (!name || !email || !EMAIL_RE.test(email) || !role) return fail(422, "invalid_form", "Name, valid email and a role are needed.");
      if (password.length < 10 || password.length > 128) return fail(422, "invalid_password", "Use a password of 10 to 128 characters.");
      if (await env.DB.prepare("SELECT 1 AS ok FROM users WHERE email = ?").bind(email).first()) return fail(409, "email_taken", "That email already has an account.");
      const id = newId();
      await env.DB.prepare("INSERT INTO users (id,name,email,role,pw_hash,created_at) VALUES (?,?,?,?,?,?)")
        .bind(id, name, email, role, await hashPassword(password), now()).run();
      await audit(env, user.id, "user.create", id, { role });
      return json({ user_id: id }, 201);
    }
    const roleRoute = /^\/api\/admin\/users\/([\w-]{1,64})\/role$/.exec(path);
    if (roleRoute && method === "POST") {
      const { body, bad, tooBig } = await readJson(request);
      if (tooBig || bad) return fail(400, "bad_request", "Could not read the form.");
      if (roleRoute[1] === user.id) return fail(400, "self_role", "You cannot change your own role here.");
      const role = ROLES.includes(body.role) ? body.role : null;
      if (!role) return fail(422, "invalid_role", "Unknown role.");
      const target = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(roleRoute[1]).first();
      if (!target) return fail(404, "not_found", "No such user.");
      await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, target.id).run();
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id).run();
      await audit(env, user.id, "user.role", target.id, { from: target.role, to: role });
      return json({ ok: true });
    }
    if (path === "/api/admin/events" && method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM events ORDER BY starts_at DESC").all();
      const out = [];
      for (const r of rows.results || []) out.push(await eventWithTypes(env, r));
      return json({ events: out });
    }
    if (path === "/api/admin/audit" && method === "GET") {
      const rows = await env.DB.prepare("SELECT a.action, a.target, a.detail, a.created_at, u.email AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 100").all();
      return json({ entries: rows.results });
    }
  }

  return fail(404, "not_found", "No such endpoint.");
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(self), geolocation=(), microphone=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
};
function withSecurity(res, isApi) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (isApi) headers.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    try {
      await ensureDb(env);
      if (isApi) return withSecurity(await handleApi(request, env, url), true);
      if (env.ASSETS) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404 || request.method !== "GET") return withSecurity(asset, false);
        // Client-side routes: any path without a file extension gets the app shell.
        if (!/\.[a-z0-9]{1,5}$/i.test(url.pathname)) {
          return withSecurity(await env.ASSETS.fetch(new Request(new URL("/", url), request)), false); // "/" serves the app shell; "/index.html" is not a page on the host
        }
        return withSecurity(asset, false);
      }
      return withSecurity(new Response("Not found", { status: 404 }), false);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", path: url.pathname, message: String((e && e.message) || e) }));
      return withSecurity(json({ error: "server", message: "Something went wrong on our side. Try again." }, 500), isApi);
    }
  },
};
export { handleApi, ensureDb, hashPassword, verifyPassword, normalizeCode, shortCode, parseNptLocal };
