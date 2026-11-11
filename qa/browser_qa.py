import os

import json, re, sys, time, os
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8787"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/qa-out"
WIDTHS = [int(x) for x in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["375", "768", "1024", "1440"])]
AXE = open(os.environ.get("AXE_JS", "node_modules/axe-core/axe.min.js")).read()
os.makedirs(OUT, exist_ok=True)
report = {"widths": {}}
DEMO = {
  "buyer": ("buyer@demo.melatickets.example", "DemoBuyer-2026-mela"),
  "organiser": ("organiser@demo.melatickets.example", "DemoOrganiser-2026-mela"),
  "door": ("door@demo.melatickets.example", "DemoDoor-2026-mela"),
  "admin": ("admin@demo.melatickets.example", "DemoAdmin-2026-mela"),
}

class Run:
    def __init__(self, ctx, width):
        self.ctx = ctx
        self.width = width
        self.page = ctx.new_page()
        self.page.route("**/__axe.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=AXE))
        self.page.set_viewport_size({"width": width, "height": 800})
        self.console_errors = []
        self.page_errors = []
        self.bad_responses = []
        self.page.on("console", lambda m: self.console_errors.append(m.text) if m.type == "error" else None)
        self.page.on("pageerror", lambda e: self.page_errors.append(str(e)))
        self.page.on("response", lambda r: self.bad_responses.append((r.status, r.url)) if r.status >= 400 else None)
        self.results = []
    def shot(self, name):
        d = os.path.join(OUT, f"w{self.width}")
        os.makedirs(d, exist_ok=True)
        self.page.screenshot(path=os.path.join(d, f"{name}.png"), full_page=True)
    def visit(self, path, name, expect_text=None, wait_ms=500):
        self.page.goto(BASE + path, wait_until="domcontentloaded")
        self.page.wait_for_load_state("networkidle")
        if expect_text:
            try:
                self.page.get_by_text(expect_text, exact=False).first.wait_for(timeout=8000)
            except Exception as e:
                self.results.append({"page": name, "note": f"expected text not seen: {expect_text}"})
        time.sleep(wait_ms / 1000)
        return self.check(name)
    def check(self, name):
        self.page.add_script_tag(url=BASE + "/__axe.js")
        overflow = self.page.evaluate("() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]")
        axe = self.page.evaluate("async () => { const r = await axe.run(document, {resultTypes:['violations']}); return r.violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.length})); }")
        links = self.page.evaluate("() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && h.startsWith('/'))")
        broken = []
        for h in sorted(set(links))[:60]:
            r = self.page.request.get(BASE + h, max_redirects=3)
            if r.status >= 400:
                broken.append((h, r.status))
        self.shot(name)
        text = self.page.evaluate("() => document.body.innerText")
        bad_text = [w for w in ["[object Object]", "undefined", "NaN", "null"] if w in text]
        targets = self.page.evaluate("async () => { const r = await axe.run(document, {resultTypes:['violations']}); return r.violations.flatMap(v => v.nodes.map(n => v.id + ': ' + n.target.join(' '))).slice(0, 6); }")
        entry = {"page": name, "bad_text": bad_text, "axe_targets": targets, "overflow_scroll_vs_client": overflow, "overflow": overflow[0] > overflow[1], "axe": axe, "broken_links": broken}
        self.results.append(entry)
        return entry

def login(run, who):
    email, pw = DEMO[who]
    run.page.goto(BASE + "/login", wait_until="domcontentloaded")
    run.page.wait_for_load_state("networkidle")
    run.page.fill("#email", email)
    run.page.fill("#password", pw)
    run.page.get_by_role("button", name="Log in", exact=True).click()
    run.page.wait_for_url(re.compile(r".*/$|.*/events.*|.*/tickets.*"), timeout=10000)
    run.page.wait_for_load_state("networkidle")

def logout(run):
    run.page.get_by_role("button", name=re.compile(r"^Log out")).click()
    run.page.wait_for_load_state("networkidle")
    time.sleep(0.4)

def run_width(p, width):
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": width, "height": 800}, device_scale_factor=1, ignore_https_errors=True)
    r = Run(ctx, width)
    res = {}
    try:
        # ---- guest ----
        r.visit("/", "guest-home", "Tickets for local events")
        r.visit("/events", "guest-events", "Events")
        r.visit("/events/demo-lantern", "guest-event", "Log in to buy", 300)
        r.visit("/login", "login", "Demo accounts")
        r.visit("/register", "register", "Sign up")
        r.visit("/terms", "terms")
        r.visit("/privacy", "privacy")
        r.visit("/organiser", "guest-organiser", "Log in", 200)
        r.visit("/does-not-exist", "not-found", "Page not found")
        # ---- buyer ----
        login(r, "buyer")
        r.visit("/events/demo-lantern", "buyer-event", "Tickets", 300)
        # pick one general ticket and reserve
        r.page.get_by_role("button", name=re.compile(r"^More General \(demo price\)")).click()
        r.page.get_by_role("button", name="Reserve tickets").click()
        r.page.wait_for_url(re.compile(r".*/orders/.*"), timeout=10000)
        r.page.wait_for_load_state("networkidle")
        time.sleep(0.6)
        qr_ok = r.page.evaluate("() => [...document.images].filter(i => i.alt.startsWith('QR code')).map(i => i.complete && i.naturalWidth > 0)")
        r.results.append({"page": "buyer-order-after-reserve-qr", "qr_images": qr_ok})
        r.check("buyer-order-after-reserve")
        r.shot("buyer-order-after-reserve")
        r.visit("/tickets", "buyer-my-tickets", "My tickets")
        r.visit("/orders/demo-order-1", "buyer-demo-order", "Your order")
        # ---- organiser ----
        logout(r)
        login(r, "organiser")
        r.visit("/organiser", "organiser-events", "Your events")
        r.visit("/organiser/new", "organiser-new-event", "New event")
        r.visit("/organiser/events/demo-lantern", "organiser-event-details", "Door staff")
        for tab in ["Tickets", "Door staff", "Orders"]:
            r.page.get_by_role("button", name=tab, exact=True).click()
            time.sleep(0.3)
            r.check(f"organiser-event-{tab.lower().replace(' ', '-')}")
            r.shot(f"organiser-event-{tab.lower().replace(' ', '-')}")
        # ---- door ----
        logout(r)
        login(r, "door")
        r.visit("/door", "door-events", "Choose an event")
        r.visit("/door/demo-lantern", "door-screen", "Ticket code")
        r.page.fill("#code", "7KQ4-M9TR")
        r.page.get_by_role("button", name="Check in", exact=True).click()
        r.page.get_by_text("Valid · let in").first.wait_for(timeout=8000)
        r.shot("door-after-valid")
        r.page.fill("#code", "7KQ4M9TR")
        r.page.get_by_role("button", name="Check in", exact=True).click()
        r.page.get_by_text("Already used").first.wait_for(timeout=8000)
        r.check("door-after-duplicate")
        r.shot("door-after-duplicate")
        # ---- admin ----
        logout(r)
        login(r, "admin")
        r.visit("/admin", "admin", "Users and roles")
    except Exception as e:
        res["script_error"] = repr(e)[:800]
    finally:
        res["console_errors"] = r.console_errors
        res["page_errors"] = r.page_errors
        res["bad_responses"] = sorted(set(map(lambda x: f"{x[0]} {x[1].replace(BASE,'')}", r.bad_responses)))
        res["pages"] = r.results
        report["widths"][str(width)] = res
        browser.close()

with sync_playwright() as p:
    for w in WIDTHS:
        run_width(p, w)
json.dump(report, open(os.path.join(OUT, f"qa-{'-'.join(str(w) for w in WIDTHS)}.json"), "w"), indent=1, default=str)
print("done", OUT)
