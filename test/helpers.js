import worker from "../site/_worker.js";
import { makeD1 } from "./d1-node.js";

export const ORIGIN = "https://mela.test";
export const DEMO = {
  buyer: { email: "buyer@demo.melatickets.example", password: "DemoBuyer-2026-mela" },
  organiser: { email: "organiser@demo.melatickets.example", password: "DemoOrganiser-2026-mela" },
  door: { email: "door@demo.melatickets.example", password: "DemoDoor-2026-mela" },
  admin: { email: "admin@demo.melatickets.example", password: "DemoAdmin-2026-mela" },
};

// A fresh database with the schema created and the demo data seeded (the first request does that).
export async function newEnv(extra = {}) {
  const env = { DB: makeD1(), ...extra };
  await worker.fetch(new Request(ORIGIN + "/api/events"), env);
  return env;
}

// A browser-like client: keeps cookies, fetches the CSRF token, sends Origin.
export class Client {
  constructor(env, ip = "203.0.113.10") {
    this.env = env;
    this.ip = ip;
    this.cookies = {};
    this.csrf = null;
  }
  async req(method, path, body, extraHeaders = {}) {
    const headers = { "cf-connecting-ip": this.ip, ...extraHeaders };
    const cookieHeader = Object.entries(this.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    if (cookieHeader) headers.cookie = cookieHeader;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") {
      if (!("origin" in extraHeaders)) headers.origin = ORIGIN;
      if (this.csrf && !("x-csrf-token" in extraHeaders)) headers["x-csrf-token"] = this.csrf;
    }
    const res = await worker.fetch(
      new Request(ORIGIN + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
      this.env,
    );
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = decodeURIComponent(pair.slice(i + 1));
      if (/Max-Age=0/i.test(sc) || value === "") delete this.cookies[name];
      else this.cookies[name] = value;
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* html or plain text */ }
    return { status: res.status, data, res };
  }
  async ensureCsrf() {
    if (!this.csrf) {
      const r = await this.req("GET", "/api/session");
      this.csrf = r.data.csrf;
    }
  }
  get(path) { return this.req("GET", path); }
  async post(path, body = {}, extra = {}) { await this.ensureCsrf(); return this.req("POST", path, body, extra); }
  async put(path, body = {}) { await this.ensureCsrf(); return this.req("PUT", path, body); }
  async login(who) {
    await this.ensureCsrf();
    return this.post("/api/auth/login", DEMO[who]);
  }
  async register(name, email, password, organiser = false) {
    await this.ensureCsrf();
    return this.post("/api/auth/register", { name, email, password, organiser });
  }
}

export let counter = 0;
export function uniqueEmail(prefix = "u") {
  counter += 1;
  return `${prefix}${counter}.${Date.now().toString(36)}@example.com`;
}
export function ipFor(n) {
  return `198.51.100.${(n % 250) + 1}`;
}
