import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const site = (f) => readFileSync(fileURLToPath(new URL(`../site/${f}`, import.meta.url)), "utf8");

test("browser code never writes raw HTML (names from the server cannot inject markup)", () => {
  const js = site("app.js");
  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
    assert.ok(!js.includes(banned), `app.js must not use ${banned}`);
  }
});

test("no inline style attributes in the HTML shell (CSP style-src 'self')", () => {
  assert.ok(!/\sstyle\s*=/.test(site("index.html")), "index.html has an inline style attribute");
});

test("no inline event handler attributes in the HTML shell", () => {
  assert.ok(!/\son[a-z]+\s*=/i.test(site("index.html")));
});

test("every font the stylesheet loads is shipped", () => {
  const css = site("fonts/fonts.css");
  const files = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(files.length >= 6);
  for (const f of files) assert.doesNotThrow(() => readFileSync(fileURLToPath(new URL(`../site/fonts/${f}`, import.meta.url))), f);
});

test("the QR encoder is the vendored MIT file, loaded as a module", () => {
  assert.match(site("vendor/qrcode.mjs"), /Kazuhiko Arase/);
  assert.match(site("app.js"), /import qrcode from "\.\/vendor\/qrcode\.mjs"/);
});
