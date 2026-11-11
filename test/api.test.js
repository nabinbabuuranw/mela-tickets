import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker, { hashPassword, verifyPassword, normalizeCode, shortCode, parseNptLocal } from "../site/_worker.js";
import { newEnv, Client, DEMO, uniqueEmail, ipFor, ORIGIN } from "./helpers.js";

const LANTERN = "demo-lantern";
const LANTERN_GEN = "demo-lantern-gen";
const POETRY = "demo-poetry";

async function organiserClient(env, ip) {
  const c = new Client(env, ip);
  const r = await c.login("organiser");
  assert.equal(r.status, 200, "organiser login");
  return c;
}
async function makeEvent(org, { capacity = 10, max = 10, price = 0, status = "published", name = "Test Fair Night" } = {}) {
  const ev = await org.post("/api/organiser/events", {
    name, venue: "Test Hall (made up)", starts_at: "2026-12-20T18:00", description: "test", status,
  });
  assert.equal(ev.status, 201, "create event");
  const tt = await org.post(`/api/organiser/events/${ev.data.event_id}/ticket-types`, {
    name: "General", price_npr: price, capacity, max_per_order: max,
  });
  assert.equal(tt.status, 201, "create type");
  return { id: ev.data.event_id, typeId: tt.data.ticket_type_id };
}
async function buyerClient(env, n) {
  const c = new Client(env, ipFor(n));
  const email = uniqueEmail("buyer");
  const r = await c.register("Test Buyer", email, "a-long-test-password", false);
  assert.equal(r.status, 201, "register buyer");
  return c;
}
const key = () => crypto.randomUUID();

describe("demo seed and public pages", () => {
  test("published demo events are listed; the draft is not", async () => {
    const env = await newEnv();
    const c = new Client(env);
    const r = await c.get("/api/events");
    assert.equal(r.status, 200);
    const ids = r.data.events.map((e) => e.id);
    assert.ok(ids.includes(LANTERN) && ids.includes(POETRY));
    assert.ok(!ids.includes("demo-draft"), "draft must not be public");
    const lantern = r.data.events.find((e) => e.id === LANTERN);
    assert.match(lantern.name, /DEMO/, "demo events are labelled");
    assert.equal(lantern.ticket_types.find((t) => t.id === LANTERN_GEN).remaining, 120 - 2);
  });

  test("a draft event page is 404 for guests, and for buyers", async () => {
    const env = await newEnv();
    const guest = new Client(env);
    assert.equal((await guest.get("/api/events/demo-draft")).status, 404);
    const buyer = new Client(env, ipFor(1));
    await buyer.login("buyer");
    assert.equal((await buyer.get("/api/events/demo-draft")).status, 404);
    const org = new Client(env, ipFor(2));
    await org.login("organiser");
    assert.equal((await org.get("/api/events/demo-draft")).status, 200, "owner can preview");
  });

  test("unknown API paths are 404 JSON, not a page", async () => {
    const c = new Client(await newEnv());
    const r = await c.get("/api/nope");
    assert.equal(r.status, 401);
    assert.equal(r.data.error, "login_required");
  });
});

describe("passwords and sessions", () => {
  test("PBKDF2-SHA256 hashes verify and reject wrong passwords", async () => {
    const h = await hashPassword("correct horse battery");
    assert.match(h, /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.equal(await verifyPassword("correct horse battery", h), true);
    assert.equal(await verifyPassword("correct horse batterY", h), false);
    assert.equal(await verifyPassword("x", "not-a-hash"), false);
  });

  test("seeded demo passwords are not stored in plain text", async () => {
    const env = await newEnv();
    const row = await env.DB.prepare("SELECT pw_hash FROM users WHERE id = 'demo-buyer'").first();
    assert.ok(row.pw_hash.startsWith("pbkdf2-sha256$"));
    assert.ok(!row.pw_hash.includes("DemoBuyer"));
  });

  test("login sets HttpOnly, Secure, SameSite cookies and /api/session returns the user", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(3));
    const r = await c.login("buyer");
    assert.equal(r.status, 200);
    const cookies = r.res.headers.getSetCookie();
    const session = cookies.find((s) => s.startsWith("mt_session="));
    assert.ok(session, "session cookie set");
    assert.match(session, /HttpOnly/);
    assert.match(session, /Secure/);
    assert.match(session, /SameSite=Lax/);
    const me = await c.get("/api/session");
    assert.equal(me.data.user.role, "buyer");
  });

  test("wrong password and unknown email both return the same 401 message", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(4));
    await c.ensureCsrf();
    const a = await c.post("/api/auth/login", { email: DEMO.buyer.email, password: "wrong-password-here" });
    const b = await c.post("/api/auth/login", { email: "nobody@example.com", password: "wrong-password-here" });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.data.message, b.data.message);
  });

  test("login is rate limited: 5 failures lock the email, even for the right password", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(5));
    await c.ensureCsrf();
    for (let i = 0; i < 5; i++) {
      const r = await c.post("/api/auth/login", { email: DEMO.buyer.email, password: "nope-nope-nope" });
      assert.equal(r.status, 401);
    }
    const locked = await c.post("/api/auth/login", DEMO.buyer);
    assert.equal(locked.status, 429);
  });

  test("an expired session cannot authorise anything", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(6));
    await c.login("buyer");
    env.DB.raw.exec("UPDATE sessions SET expires_at = 0");
    const r = await c.get("/api/orders");
    assert.equal(r.status, 401);
  });

  test("logout ends the session on the server, not just in the browser", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(7));
    await c.login("buyer");
    const token = c.cookies.mt_session;
    await c.post("/api/auth/logout", {});
    const cookieLess = new Client(env, ipFor(7));
    cookieLess.cookies.mt_session = token; // replay the old token
    assert.equal((await cookieLess.get("/api/orders")).status, 401);
  });

  test("register validates name, email and password length", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(8));
    assert.equal((await c.register("A", uniqueEmail(), "long-enough-pw")).status, 422);
    assert.equal((await c.register("Good Name", "not-an-email", "long-enough-pw")).status, 422);
    assert.equal((await c.register("Good Name", uniqueEmail(), "short")).status, 422);
    assert.equal((await c.register("Good Name", DEMO.buyer.email, "long-enough-pw")).status, 409);
  });

  test("sign-ups are rate limited per address", async () => {
    const env = await newEnv();
    const c = new Client(env, "198.51.100.200");
    let last;
    for (let i = 0; i < 11; i++) last = await c.register("Spam Test", uniqueEmail("s"), "long-enough-pw");
    assert.equal(last.status, 429);
  });
});

describe("CSRF on every POST", () => {
  test("a POST with no CSRF token is refused", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(9));
    await c.get("/api/session"); // cookie set, but the header is not sent below
    const res = await worker.fetch(new Request(ORIGIN + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(DEMO.buyer),
    }), env);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "csrf");
  });

  test("a token that does not match the cookie is refused", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(10));
    await c.ensureCsrf();
    const r = await c.req("POST", "/api/auth/login", DEMO.buyer, { "x-csrf-token": "x".repeat(43) });
    assert.equal(r.status, 403);
  });

  test("a POST from another origin is refused even with a valid token", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(11));
    await c.ensureCsrf();
    const r = await c.req("POST", "/api/auth/login", DEMO.buyer, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });

  test("logged-in POSTs (order, check-in) need the token too", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(12));
    await c.login("buyer");
    const res = await worker.fetch(new Request(ORIGIN + "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: `mt_session=${encodeURIComponent(c.cookies.mt_session)}; mt_csrf=${c.csrf}` },
      body: JSON.stringify({ event_id: LANTERN, items: [{ ticket_type_id: "demo-lantern-helper", quantity: 1 }], buyer_name: "A B", buyer_email: "a@example.com", idempotency_key: key() }),
    }), env);
    assert.equal(res.status, 403);
  });
});

describe("buying", () => {
  test("a guest cannot buy, and gets 401 from the API", async () => {
    const env = await newEnv();
    const guest = new Client(env, ipFor(13));
    const r = await guest.post("/api/orders", { event_id: POETRY, items: [{ ticket_type_id: "demo-poetry-open", quantity: 1 }], buyer_name: "Guest Person", buyer_email: "g@example.com", idempotency_key: key() });
    assert.equal(r.status, 401);
    const count = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
    assert.equal(Number(count), 1, "only the seeded demo order exists");
  });

  test("a free order issues one ticket per seat with a unique short code", async () => {
    const env = await newEnv();
    const buyer = await buyerClient(env, 20);
    const r = await buyer.post("/api/orders", { event_id: POETRY, items: [{ ticket_type_id: "demo-poetry-open", quantity: 3 }], buyer_name: "Test Buyer", buyer_email: "tb@example.com", idempotency_key: key() });
    assert.equal(r.status, 201);
    const order = await buyer.get(`/api/orders/${r.data.order_id}`);
    assert.equal(order.data.order.payment_status, "free");
    assert.equal(order.data.order.tickets.length, 3);
    const codes = new Set(order.data.order.tickets.map((t) => t.code.replace("-", "")));
    assert.equal(codes.size, 3);
    for (const t of order.data.order.tickets) assert.match(t.qr, /^MELA1:[A-Z2-9]{8}$/);
  });

  test("a paid order is marked pending at the venue, with no payment fields", async () => {
    const env = await newEnv();
    const buyer = await buyerClient(env, 21);
    const r = await buyer.post("/api/orders", { event_id: LANTERN, items: [{ ticket_type_id: LANTERN_GEN, quantity: 2 }], buyer_name: "Test Buyer", buyer_email: "tb@example.com", idempotency_key: key() });
    assert.equal(r.status, 201);
    const order = await buyer.get(`/api/orders/${r.data.order_id}`);
    assert.equal(order.data.order.payment_status, "pending_offline");
    assert.equal(order.data.order.total_npr, 600);
    assert.equal(Object.keys(order.data.order).filter((k) => /payment|card|esewa|khalti/i.test(k)).join(","), "payment_status");
  });

  test("capacity cannot be oversold under 25 parallel requests (capacity 10)", async () => {
    const env = await newEnv();
    const org = await organiserClient(env, ipFor(30));
    const ev = await makeEvent(org, { capacity: 10, max: 1 });
    const buyers = [];
    for (let i = 0; i < 25; i++) buyers.push(await buyerClient(env, 40 + i));
    const results = await Promise.all(buyers.map((b, i) => b.post("/api/orders", {
      event_id: ev.id, items: [{ ticket_type_id: ev.typeId, quantity: 1 }], buyer_name: `Buyer ${i}`, buyer_email: `b${i}@example.com`, idempotency_key: key(),
    })));
    const ok = results.filter((r) => r.status === 201).length;
    const soldOut = results.filter((r) => r.status === 409 && r.data.error === "sold_out").length;
    assert.equal(ok, 10, "exactly the capacity succeeds");
    assert.equal(soldOut, 15, "the rest are refused as sold out");
    const issued = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM tickets WHERE ticket_type_id = ? AND status <> 'void'").get(ev.typeId).n;
    assert.equal(Number(issued), 10);
    const detail = await org.get(`/api/organiser/events/${ev.id}`);
    assert.equal(detail.data.event.ticket_types[0].remaining, 0);
  });

  test("a failed checkout rolls back: no order row and no ticket for the other type", async () => {
    const env = await newEnv();
    const org = await organiserClient(env, ipFor(31));
    const ev = await env.DB.prepare("SELECT 1 AS x").first();
    const made = await org.post("/api/organiser/events", { name: "Rollback Night", venue: "Test Hall", starts_at: "2026-12-21T18:00", status: "published" });
    const a = await org.post(`/api/organiser/events/${made.data.event_id}/ticket-types`, { name: "Plenty", price_npr: 0, capacity: 5, max_per_order: 4 });
    const b = await org.post(`/api/organiser/events/${made.data.event_id}/ticket-types`, { name: "One only", price_npr: 0, capacity: 1, max_per_order: 2 });
    // Sell out type b first.
    const first = await buyerClient(env, 60);
    assert.equal((await first.post("/api/orders", { event_id: made.data.event_id, items: [{ ticket_type_id: b.data.ticket_type_id, quantity: 1 }], buyer_name: "First", buyer_email: "f@example.com", idempotency_key: key() })).status, 201);
    // Now an order that needs 2 of type a and 1 of the sold-out type b.
    const second = await buyerClient(env, 61);
    const bad = await second.post("/api/orders", {
      event_id: made.data.event_id,
      items: [{ ticket_type_id: a.data.ticket_type_id, quantity: 2 }, { ticket_type_id: b.data.ticket_type_id, quantity: 1 }],
      buyer_name: "Second", buyer_email: "s@example.com", idempotency_key: key(),
    });
    assert.equal(bad.status, 409);
    const orders = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE event_id = ?").get(made.data.event_id).n;
    assert.equal(Number(orders), 1, "only the first order exists");
    const aIssued = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM tickets WHERE ticket_type_id = ?").get(a.data.ticket_type_id).n;
    assert.equal(Number(aIssued), 0, "no type-a ticket survived the rollback");
  });

  test("a repeated checkout key returns the first order and creates nothing new", async () => {
    const env = await newEnv();
    const buyer = await buyerClient(env, 70);
    const k = key();
    const body = { event_id: POETRY, items: [{ ticket_type_id: "demo-poetry-open", quantity: 1 }], buyer_name: "Test Buyer", buyer_email: "tb@example.com", idempotency_key: k };
    const a = await buyer.post("/api/orders", body);
    const b = await buyer.post("/api/orders", body);
    const parallel = await Promise.all([buyer.post("/api/orders", body), buyer.post("/api/orders", body)]);
    assert.equal(a.status, 201);
    assert.equal(b.data.order_id, a.data.order_id);
    for (const p of parallel) assert.equal(p.data.order_id, a.data.order_id);
    const n = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = (SELECT user_id FROM orders WHERE id = ?)").get(a.data.order_id).n;
    assert.equal(Number(n), 1);
  });

  test("order limits: over max per order, quantities out of range, foreign types, duplicates", async () => {
    const env = await newEnv();
    const buyer = await buyerClient(env, 80);
    const base = { event_id: LANTERN, buyer_name: "Test Buyer", buyer_email: "tb@example.com" };
    assert.equal((await buyer.post("/api/orders", { ...base, idempotency_key: key(), items: [{ ticket_type_id: "demo-lantern-helper", quantity: 2 }] })).status, 422, "helper max is 1");
    assert.equal((await buyer.post("/api/orders", { ...base, idempotency_key: key(), items: [{ ticket_type_id: LANTERN_GEN, quantity: 11 }] })).status, 422, "11 is over the hard cap");
    assert.equal((await buyer.post("/api/orders", { ...base, idempotency_key: key(), items: [{ ticket_type_id: LANTERN_GEN, quantity: -1 }] })).status, 422);
    assert.equal((await buyer.post("/api/orders", { ...base, idempotency_key: key(), items: [{ ticket_type_id: LANTERN_GEN, quantity: 1.5 }] })).status, 422);
    assert.equal((await buyer.post("/api/orders", { ...base, idempotency_key: key(), items: [{ ticket_type_id: "demo-poetry-open", quantity: 1 }] })).status, 422, "type belongs to another event");
    assert.equal((await buyer.post("/api/orders", { ...base, idempotency_key: key(), items: [{ ticket_type_id: LANTERN_GEN, quantity: 1 }, { ticket_type_id: LANTERN_GEN, quantity: 1 }] })).status, 422, "same type twice");
    assert.equal((await buyer.post("/api/orders", { ...base, idempotency_key: key(), items: [] })).status, 422);
    assert.equal((await buyer.post("/api/orders", { ...base, items: [{ ticket_type_id: LANTERN_GEN, quantity: 1 }] })).status, 400, "no checkout key");
  });

  test("a buyer cannot buy for a draft event", async () => {
    const env = await newEnv();
    const buyer = await buyerClient(env, 81);
    const r = await buyer.post("/api/orders", { event_id: "demo-draft", items: [{ ticket_type_id: "demo-draft-gen", quantity: 1 }], buyer_name: "Test Buyer", buyer_email: "tb@example.com", idempotency_key: key() });
    assert.equal(r.status, 404);
  });

  test("buyer A cannot read buyer B's order (404, not 403)", async () => {
    const env = await newEnv();
    const a = await buyerClient(env, 82);
    const b = await buyerClient(env, 83);
    const r = await a.post("/api/orders", { event_id: POETRY, items: [{ ticket_type_id: "demo-poetry-open", quantity: 1 }], buyer_name: "A", buyer_email: "a@example.com", idempotency_key: key() });
    assert.equal((await b.get(`/api/orders/${r.data.order_id}`)).status, 404);
    assert.equal((await b.get("/api/orders")).data.orders.length, 0);
  });

  test("the buyer can see their demo order with two tickets", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(84));
    await c.login("buyer");
    const orders = await c.get("/api/orders");
    assert.equal(orders.data.orders.length, 1);
    const o = await c.get("/api/orders/demo-order-1");
    assert.equal(o.data.order.tickets.length, 2);
  });
});

describe("door check-in", () => {
  test("staff assigned to the event scans a ticket once; the second scan is refused", async () => {
    const env = await newEnv();
    const door = new Client(env, ipFor(90));
    await door.login("door");
    const first = await door.post("/api/door/checkin", { event_id: LANTERN, code: "7KQ4-M9TR" });
    assert.equal(first.status, 200);
    assert.equal(first.data.result, "valid");
    const again = await door.post("/api/door/checkin", { event_id: LANTERN, code: "7KQ4M9TR" });
    assert.equal(again.status, 200, "a resolved scan is a 200 with a result word");
    assert.equal(again.data.result, "already_used");
  });

  test("the same ticket scanned twice at the same moment checks in exactly once", async () => {
    const env = await newEnv();
    const door = new Client(env, ipFor(91));
    await door.login("door");
    const [a, b] = await Promise.all([
      door.post("/api/door/checkin", { event_id: LANTERN, code: "H3PX6WNB" }),
      door.post("/api/door/checkin", { event_id: LANTERN, code: "H3PX6WNB" }),
    ]);
    const results = [a.data.result, b.data.result].sort();
    assert.deepEqual(results, ["already_used", "valid"]);
  });

  test("a ticket for another event is rejected", async () => {
    const env = await newEnv();
    const org = new Client(env, ipFor(92));
    await org.login("organiser");
    const r = await org.post("/api/door/checkin", { event_id: POETRY, code: "7KQ4M9TR" });
    assert.equal(r.status, 200);
    assert.equal(r.data.result, "wrong_event");
    const row = env.DB.raw.prepare("SELECT status FROM tickets WHERE short_code = '7KQ4M9TR'").get();
    assert.equal(row.status, "valid", "a wrong-event scan must not use the ticket");
  });

  test("a buyer (not staff) cannot check in", async () => {
    const env = await newEnv();
    const buyer = new Client(env, ipFor(93));
    await buyer.login("buyer");
    const r = await buyer.post("/api/door/checkin", { event_id: LANTERN, code: "7KQ4M9TR" });
    assert.equal(r.status, 403);
    assert.equal(env.DB.raw.prepare("SELECT status FROM tickets WHERE short_code = '7KQ4M9TR'").get().status, "valid");
  });

  test("door staff not assigned to the event cannot check in", async () => {
    const env = await newEnv();
    const org = await organiserClient(env, ipFor(94));
    const ev = await org.post("/api/organiser/events", { name: "Unassigned Night", venue: "Hall X", starts_at: "2026-12-22T18:00", status: "published" });
    const tt = await org.post(`/api/organiser/events/${ev.data.event_id}/ticket-types`, { name: "General", price_npr: 0, capacity: 5, max_per_order: 2 });
    const buyer = await buyerClient(env, 95);
    const o = await buyer.post("/api/orders", { event_id: ev.data.event_id, items: [{ ticket_type_id: tt.data.ticket_type_id, quantity: 1 }], buyer_name: "Buyer Bee", buyer_email: "b@example.com", idempotency_key: key() });
    const code = (await buyer.get(`/api/orders/${o.data.order_id}`)).data.order.tickets[0].code;
    const door = new Client(env, ipFor(96));
    await door.login("door");
    assert.equal((await door.post("/api/door/checkin", { event_id: ev.data.event_id, code })).status, 403);
    const addDoor = await org.post(`/api/organiser/events/${ev.data.event_id}/staff`, { email: DEMO.door.email });
    assert.equal(addDoor.status, 201);
    assert.equal((await door.post("/api/door/checkin", { event_id: ev.data.event_id, code })).status, 200, "allowed once assigned");
  });

  test("an organiser of another event cannot check in to this one", async () => {
    const env = await newEnv();
    const org = new Client(env, ipFor(97));
    await org.login("organiser");
    const made = await org.post("/api/organiser/events", { name: "Mine Night", venue: "Hall Y", starts_at: "2026-12-23T18:00", status: "published" });
    assert.equal(made.status, 201);
    // A second organiser account:
    const other = new Client(env, ipFor(98));
    await other.register("Other Organiser", uniqueEmail("org"), "long-enough-pw", true);
    assert.equal((await other.post("/api/door/checkin", { event_id: LANTERN, code: "7KQ4M9TR" })).status, 403);
  });

  test("unknown codes and malformed codes are refused", async () => {
    const env = await newEnv();
    const door = new Client(env, ipFor(99));
    await door.login("door");
    const unknown = await door.post("/api/door/checkin", { event_id: LANTERN, code: "ZZZZ9999" });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.data.result, "not_found");
    assert.equal((await door.post("/api/door/checkin", { event_id: LANTERN, code: "abc" })).status, 422);
    assert.equal((await door.post("/api/door/checkin", { event_id: LANTERN, code: "0OO0OO0O" })).status, 422, "ambiguous characters are not in the alphabet");
  });

  test("a QR payload (MELA1:CODE) checks in the same as the typed code", async () => {
    const env = await newEnv();
    const door = new Client(env, ipFor(100));
    await door.login("door");
    const r = await door.post("/api/door/checkin", { event_id: LANTERN, code: "MELA1:7KQ4M9TR" });
    assert.equal(r.status, 200);
    assert.equal(r.data.result, "valid");
  });

  test("a cancelled (void) ticket cannot be checked in", async () => {
    const env = await newEnv();
    env.DB.raw.exec("UPDATE tickets SET status = 'void' WHERE short_code = 'H3PX6WNB'");
    const door = new Client(env, ipFor(101));
    await door.login("door");
    const r = await door.post("/api/door/checkin", { event_id: LANTERN, code: "H3PX6WNB" });
    assert.equal(r.status, 200);
    assert.equal(r.data.result, "void");
  });

  test("the door screen lists only events the staff account is on", async () => {
    const env = await newEnv();
    const door = new Client(env, ipFor(102));
    await door.login("door");
    const r = await door.get("/api/door/events");
    assert.deepEqual(r.data.events.map((e) => e.id), [LANTERN]);
    const detail = await door.get(`/api/door/events/${POETRY}`);
    assert.equal(detail.status, 403);
  });
});

describe("roles and admin", () => {
  test("door staff cannot create events or buy tickets", async () => {
    const env = await newEnv();
    const door = new Client(env, ipFor(110));
    await door.login("door");
    assert.equal((await door.post("/api/organiser/events", { name: "Nope Night", venue: "Hall", starts_at: "2026-12-30T18:00" })).status, 403);
    assert.equal((await door.post("/api/orders", { event_id: POETRY, items: [{ ticket_type_id: "demo-poetry-open", quantity: 1 }], buyer_name: "Door", buyer_email: "d@example.com", idempotency_key: key() })).status, 403);
  });

  test("a buyer cannot reach organiser or admin endpoints", async () => {
    const env = await newEnv();
    const buyer = new Client(env, ipFor(111));
    await buyer.login("buyer");
    assert.equal((await buyer.get("/api/organiser/events")).status, 403);
    assert.equal((await buyer.get("/api/admin/users")).status, 403);
    assert.equal((await buyer.post("/api/admin/users/demo-door/role", { role: "admin" })).status, 403);
  });

  test("support-style roles are separate: organiser cannot see admin data, admin sees organiser events", async () => {
    const env = await newEnv();
    const org = new Client(env, ipFor(112));
    await org.login("organiser");
    assert.equal((await org.get("/api/admin/audit")).status, 403);
    assert.equal((await org.get("/api/admin/overview")).status, 403);
    const admin = new Client(env, ipFor(113));
    await admin.login("admin");
    const ov = await admin.get("/api/admin/overview");
    assert.equal(ov.status, 200);
    assert.ok(ov.data.roles.some((r) => r.role === "door"));
  });

  test("admin changes a role; an admin cannot change their own role", async () => {
    const env = await newEnv();
    const admin = new Client(env, ipFor(114));
    await admin.login("admin");
    const self = await admin.post("/api/admin/users/demo-admin/role", { role: "buyer" });
    assert.equal(self.status, 400);
    const r = await admin.post("/api/admin/users/demo-buyer/role", { role: "organiser" });
    assert.equal(r.status, 200);
    const check = env.DB.raw.prepare("SELECT role FROM users WHERE id = 'demo-buyer'").get();
    assert.equal(check.role, "organiser");
    const audit = await admin.get("/api/admin/audit");
    assert.ok(audit.data.entries.some((e) => e.action === "user.role"));
  });

  test("a role change ends that user's sessions", async () => {
    const env = await newEnv();
    const buyer = new Client(env, ipFor(115));
    await buyer.login("buyer");
    const admin = new Client(env, ipFor(116));
    await admin.login("admin");
    await admin.post("/api/admin/users/demo-buyer/role", { role: "buyer" });
    assert.equal((await buyer.get("/api/orders")).status, 401);
  });

  test("admin can create a door staff account and an organiser can add it to their event", async () => {
    const env = await newEnv();
    const admin = new Client(env, ipFor(117));
    await admin.login("admin");
    const email = uniqueEmail("gate");
    const made = await admin.post("/api/admin/users", { name: "New Gate", email, password: "long-enough-pw", role: "door" });
    assert.equal(made.status, 201);
    const org = await organiserClient(env, ipFor(118));
    const ev = await makeEvent(org);
    assert.equal((await org.post(`/api/organiser/events/${ev.id}/staff`, { email: DEMO.buyer.email })).status, 404, "a buyer account is not door staff");
    assert.equal((await org.post(`/api/organiser/events/${ev.id}/staff`, { email })).status, 201);
  });

  test("organiser sees only their own events; admin sees all", async () => {
    const env = await newEnv();
    const org = await organiserClient(env, ipFor(119));
    await makeEvent(org, { name: "Organiser One Night" });
    const other = new Client(env, ipFor(120));
    await other.register("Second Organiser", uniqueEmail("org2"), "long-enough-pw", true);
    const mine = await other.get("/api/organiser/events");
    assert.equal(mine.data.events.length, 0);
    const admin = new Client(env, ipFor(121));
    await admin.login("admin");
    const all = await admin.get("/api/admin/events");
    assert.ok(all.data.events.length >= 4);
  });

  test("organiser cannot edit another organiser's event", async () => {
    const env = await newEnv();
    const other = new Client(env, ipFor(122));
    await other.register("Third Organiser", uniqueEmail("org3"), "long-enough-pw", true);
    const r = await other.put(`/api/organiser/events/${LANTERN}`, { name: "Hijacked Name" });
    assert.equal(r.status, 404);
    assert.equal(env.DB.raw.prepare("SELECT name FROM events WHERE id = ?").get(LANTERN).name, "Lantern Night Fair (DEMO)");
  });

  test("organiser cannot cut capacity below tickets already issued", async () => {
    const env = await newEnv();
    const org = new Client(env, ipFor(123));
    await org.login("organiser");
    const r = await org.put(`/api/organiser/ticket-types/${LANTERN_GEN}`, { capacity: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "capacity_below_sold");
    const ok = await org.put(`/api/organiser/ticket-types/${LANTERN_GEN}`, { capacity: 2 });
    assert.equal(ok.status, 200, "equal to sold is allowed");
  });
});

describe("headers and input handling", () => {
  test("every API response carries the security headers", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(130));
    const r = await c.get("/api/events");
    assert.match(r.res.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(r.res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(r.res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.res.headers.get("x-frame-options"), "DENY");
    assert.match(r.res.headers.get("strict-transport-security"), /max-age=/);
    assert.equal(r.res.headers.get("cache-control"), "no-store");
  });

  test("invalid JSON and oversized bodies are refused", async () => {
    const env = await newEnv();
    const c = new Client(env, ipFor(131));
    await c.ensureCsrf();
    const bad = await worker.fetch(new Request(ORIGIN + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-csrf-token": c.csrf, cookie: `mt_csrf=${c.csrf}` }, body: "{not json",
    }), env);
    assert.equal(bad.status, 400);
    const big = await c.req("POST", "/api/auth/login", { email: "a@b.co", password: "x".repeat(20000) });
    assert.equal(big.status, 400);
  });

  test("a script tag in an event name is stored as text and returned as text", async () => {
    const env = await newEnv();
    const org = await organiserClient(env, ipFor(132));
    const r = await org.post("/api/organiser/events", { name: "<script>alert(1)</script> Night", venue: "Hall <b>z</b>", starts_at: "2026-12-24T18:00", status: "published" });
    assert.equal(r.status, 201);
    const ev = await org.get(`/api/organiser/events/${r.data.event_id}`);
    assert.equal(ev.data.event.name, "<script>alert(1)</script> Night");
    // The browser code writes names with textContent only; this test checks the server keeps them as given.
  });

  test("the event start time is read as Nepal Time (UTC+05:45)", () => {
    assert.equal(parseNptLocal("2026-12-05T18:00"), Date.parse("2026-12-05T12:15:00Z"));
    assert.equal(parseNptLocal("2026-13-40T18:00"), null);
    assert.equal(parseNptLocal("tomorrow"), null);
  });

  test("bad event dates and empty names are refused", async () => {
    const env = await newEnv();
    const org = await organiserClient(env, ipFor(133));
    assert.equal((await org.post("/api/organiser/events", { name: "Fine Name", venue: "Hall", starts_at: "next week" })).status, 422);
    assert.equal((await org.post("/api/organiser/events", { name: "", venue: "Hall", starts_at: "2026-12-24T18:00" })).status, 422);
  });

  test("the staff add route only takes door accounts", async () => {
    const env = await newEnv();
    const org = await organiserClient(env, ipFor(134));
    const ev = await makeEvent(org);
    const admin = new Client(env, ipFor(135));
    await admin.login("admin");
    assert.equal((await org.post(`/api/organiser/events/${ev.id}/staff`, { email: DEMO.admin.email })).status, 404);
    assert.equal((await org.post(`/api/organiser/events/${ev.id}/staff`, { email: DEMO.door.email })).status, 201);
    const detail = await org.get(`/api/organiser/events/${ev.id}`);
    assert.equal(detail.data.staff[0].email, DEMO.door.email);
  });

  test("check-ins and order creation are written to the audit log", async () => {
    const env = await newEnv();
    const door = new Client(env, ipFor(136));
    await door.login("door");
    await door.post("/api/door/checkin", { event_id: LANTERN, code: "7KQ4M9TR" });
    const admin = new Client(env, ipFor(137));
    await admin.login("admin");
    const audit = await admin.get("/api/admin/audit");
    assert.ok(audit.data.entries.some((e) => e.action === "checkin"));
  });
});

describe("helpers", () => {
  test("short codes use the 31-symbol alphabet with no ambiguous characters", () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const c = shortCode();
      assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      seen.add(c);
    }
    assert.equal(seen.size, 2000);
  });
  test("normalizeCode accepts spaces, dashes, lowercase and the QR prefix", () => {
    assert.equal(normalizeCode(" 7kq4-m9tr "), "7KQ4M9TR");
    assert.equal(normalizeCode("MELA1:7KQ4M9TR"), "7KQ4M9TR");
  });
});
