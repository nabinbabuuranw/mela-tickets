// Local preview server: runs the same _worker.js the publish step ships, with static files from site/.
// In memory only; restarting resets the demo data. For QA, not for deployment.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../site/_worker.js";
import { makeD1 } from "../test/d1-node.js";

const root = resolve(fileURLToPath(new URL("../site/", import.meta.url)));
const port = Number(process.env.PORT || 8787);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".mjs": "text/javascript; charset=utf-8" };

const env = { DB: makeD1() };
env.ASSETS = {
  async fetch(req) {
    const u = new URL(req.url);
    const rel = normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, "");
    if (rel.includes("..") || rel === "_worker.js" || rel === "tab-site.json") return new Response("Not found", { status: 404 });
    const file = join(root, rel || "index.html");
    try {
      const s = await stat(file);
      if (!s.isFile()) return new Response("Not found", { status: 404 });
      return new Response(await readFile(file), { status: 200, headers: { "content-type": types[extname(file)] || "application/octet-stream" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`); // same host as the browser sends, so Origin matches
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  headers.set("cf-connecting-ip", req.socket.remoteAddress || "127.0.0.1");
  const request = new Request(url, { method: req.method, headers, body: body && body.length && req.method !== "GET" ? body : undefined });
  const out = await worker.fetch(request, env);
  const buf = Buffer.from(await out.arrayBuffer());
  const h = {};
  out.headers.forEach((v, k) => { h[k] = v; });
  if (out.headers.getSetCookie) { const sc = out.headers.getSetCookie(); if (sc.length) h["set-cookie"] = sc; }
  res.writeHead(out.status, h);
  res.end(buf);
});
server.listen(port, "127.0.0.1", () => console.log(`listening on ${port}`));
