// Mela Tickets: browser code. Plain modules, no framework. Every value from the server is
// written as text nodes only, so names and text from the server cannot inject markup.
import qrcode from "./vendor/qrcode.mjs";

const state = { user: null, csrf: "", loaded: false, token: 0 };
const app = document.getElementById("app");
const nav = document.getElementById("nav");
const TZ = "Asia/Kathmandu";

// ---------- DOM helpers ----------
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k === "style") node.style.cssText = String(v); // CSSOM, allowed by the CSP; attribute styles are not
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
const setMain = (...nodes) => { app.replaceChildren(...nodes.flat()); app.focus({ preventScroll: true }); };
const money = (n) => (Number(n) === 0 ? "Free" : `NPR ${Number(n).toLocaleString("en-IN")}`);
const npt = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms)) + " NPT";
const nptShort = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms));
function nptInputValue(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const skeleton = (lines = 4) => el("div", { class: "skeleton", "aria-busy": "true", "aria-live": "polite" }, Array.from({ length: lines }, () => el("span")));
const alertBox = (message, title = "Something did not work.") => el("div", { class: "alert", role: "alert" }, el("strong", { text: title + " " }), message);
const emptyBox = (title, text, action) => el("div", { class: "empty" }, el("strong", { text: title }), text ? el("p", { text, class: "small" }) : null, action || null);
const link = (href, text, cls) => el("a", { href, class: cls, "data-link": "" , text });
const btn = (text, onclick, opts = {}) => el("button", { type: "button", class: `btn ${opts.cls || ""}`, onclick, disabled: opts.disabled, text });

// ---------- server calls ----------
async function api(method, path, body) {
  const opts = { method, headers: { accept: "application/json" }, credentials: "same-origin" };
  if (method !== "GET") {
    opts.headers["content-type"] = "application/json";
    opts.headers["x-csrf-token"] = state.csrf;
  }
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(path, opts);
    if (res.status === 403 && method !== "GET") {
      const peek = await res.clone().json().catch(() => ({}));
      if (peek.error === "csrf") {
        await loadSession();
        opts.headers["x-csrf-token"] = state.csrf;
        res = await fetch(path, opts);
      }
    }
  } catch {
    return { status: 0, data: { error: "network", message: "No connection. Check your signal and try again." } };
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function loadSession() {
  const r = await api("GET", "/api/session");
  if (r.status === 200) { state.user = r.data.user; state.csrf = r.data.csrf; }
  state.loaded = true;
}
const can = (...roles) => !!state.user && roles.includes(state.user.role);
const errText = (r, fallback) => (r && r.data && r.data.message) || fallback;

// ---------- navigation ----------
function renderNav() {
  const links = [
    ["/events", "Events"],
  ];
  if (state.user) links.push(["/tickets", "My tickets"]);
  if (can("organiser", "admin")) links.push(["/organiser", "Organiser"]);
  if (can("door", "organiser", "admin")) links.push(["/door", "Door"]);
  if (can("admin")) links.push(["/admin", "Admin"]);
  const current = location.pathname.replace(/\/$/, "") || "/";
  const items = links.map(([href, text]) => {
    const active = current === href || current.startsWith(href + "/");
    return el("a", { href, "data-link": "", text, ...(active ? { "aria-current": "page" } : {}) });
  });
  if (state.user) {
    items.push(el("button", { type: "button", class: "link", onclick: logout, text: `Log out (${state.user.name.split(" ")[0]})` }));
  } else {
    items.push(el("a", { href: "/login", "data-link": "", text: "Log in" }));
    items.push(el("a", { href: "/register", "data-link": "", text: "Sign up" }));
  }
  nav.replaceChildren(...items);
}
async function logout() {
  await api("POST", "/api/auth/logout", {});
  state.user = null;
  await loadSession();
  renderNav();
  go("/");
}
function go(path, replace = false) {
  if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  route();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
  const url = new URL(a.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  go(url.pathname + url.search + url.hash);
});
window.addEventListener("popstate", route);

function safeNext(raw) {
  // Only same-site relative paths. Anything else (another host, //, a scheme) falls back to home.
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw;
}
function needLogin(next, message) {
  setTitle("Log in");
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("h1", { text: "Log in" }))),
    el("div", { class: "notice" }, el("p", { text: message || "Log in to continue." })),
    el("div", { class: "btn-row" }, link(`/login?next=${encodeURIComponent(next)}`, "Log in", "btn"), link(`/register?next=${encodeURIComponent(next)}`, "Sign up", "btn ghost"))));
}
const denied = (text = "This page is for other kinds of account.") => setMain(el("section", { class: "wrap" }, alertBox(text, "Not allowed.")));
function setTitle(t) { document.title = `${t} · Mela Tickets (demo)`; }

const routes = [
  [/^\/$/, homeView],
  [/^\/events\/?$/, eventsView],
  [/^\/events\/([\w-]{1,64})\/?$/, eventView],
  [/^\/orders\/([\w-]{1,64})\/?$/, orderView],
  [/^\/tickets\/?$/, myTicketsView],
  [/^\/login\/?$/, loginView],
  [/^\/register\/?$/, registerView],
  [/^\/organiser\/?$/, organiserListView],
  [/^\/organiser\/new\/?$/, newEventView],
  [/^\/organiser\/events\/([\w-]{1,64})\/?$/, organiserEventView],
  [/^\/door\/?$/, doorListView],
  [/^\/door\/([\w-]{1,64})\/?$/, doorEventView],
  [/^\/admin\/?$/, adminView],
  [/^\/terms\/?$/, termsView],
  [/^\/privacy\/?$/, privacyView],
];
let lastRoute = null;
async function route() {
  const token = ++state.token;
  const path = location.pathname;
  renderNav();
  if (!state.loaded) await loadSession();
  if (token !== state.token) return;
  renderNav();
  for (const [re, view] of routes) {
    const m = re.exec(path);
    if (m) {
      lastRoute = path;
      setMain(el("section", { class: "wrap", "aria-busy": "true" }, skeleton(5)));
      try {
        await view(m.slice(1), token);
      } catch (err) {
        if (token === state.token) setMain(el("section", { class: "wrap" }, alertBox("The page did not load. Reload and try again.")));
      }
      return;
    }
  }
  setTitle("Not found");
  setMain(el("section", { class: "wrap" }, el("div", { class: "page-head" }, el("div", {}, el("h1", { text: "Page not found" }))), el("p", { text: "There is no page at this address." }), link("/", "Back to the start", "btn")));
}
const stale = (token) => token !== state.token;

// ---------- views ----------
async function homeView(_, token) {
  setTitle("Event tickets");
  const r = await api("GET", "/api/events");
  if (stale(token)) return;
  const events = r.data.events || [];
  const list = r.status !== 200
    ? alertBox(errText(r, "The events did not load."))
    : events.length === 0
      ? emptyBox("No events are on sale yet.", "Organisers publish events here. Check back soon.")
      : el("ul", { class: "rows", "aria-label": "Events on sale" }, events.slice(0, 6).map(eventRow));
  setMain(
    el("section", { class: "band" }, el("div", { class: "wrap" },
      el("span", { class: "demo-note", text: "Demo only" }),
      el("h1", { text: "Tickets for local events. Each code is checked in once." }),
      el("p", { class: "lede", text: "Organisers set up an event and its ticket types. Buyers reserve tickets and get a QR code. The door team scans or types the code, and a ticket that has already been used is refused." }),
      el("div", { class: "btn-row" }, link("/events", "See all events", "btn"), link("/register?organiser=1", "Run an event", "btn ghost")),
    )),
    el("section", { class: "wrap section-gap" },
      el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "On sale" }), el("h2", { text: "Events" })), link("/events", "All events", "small")),
      list),
    el("section", { class: "wrap section-gap" },
      el("h2", { text: "How it works" }),
      el("ol", { class: "sequence" },
        el("li", {}, el("span", { class: "n", text: "01" }), el("div", {}, el("strong", { text: "The organiser publishes" }), el("span", { class: "small", text: "Name, date and time in Nepal Time, the venue, and ticket types with a capacity." }))),
        el("li", {}, el("span", { class: "n", text: "02" }), el("div", {}, el("strong", { text: "The buyer reserves" }), el("span", { class: "small", text: "Free tickets are issued at once. Paid tickets are marked pending and paid at the venue. No payment is taken here." }))),
        el("li", {}, el("span", { class: "n", text: "03" }), el("div", {}, el("strong", { text: "The door checks once" }), el("span", { class: "small", text: "Each code is valid for one entry. A second scan is refused and the screen says so.", })))),
      el("p", { class: "small section-gap", text: "Everything on this site is demo data: made-up events, venues and people. No real tickets are sold." })),
  );
}
function eventRow(ev) {
  const types = ev.ticket_types || [];
  const prices = types.map((t) => t.price_npr);
  const from = prices.length ? (Math.min(...prices) === 0 ? "Free" : `From NPR ${Math.min(...prices).toLocaleString("en-IN")}`) : "No tickets yet";
  const left = types.reduce((s, t) => s + t.remaining, 0);
  return el("li", { class: "row" },
    el("span", { class: "row-meta num", text: nptShort(ev.starts_at) }),
    el("div", {}, el("a", { href: `/events/${ev.id}`, "data-link": "", class: "row-link" }, el("span", { class: "row-title", text: ev.name })), el("div", { class: "row-meta", text: ev.venue })),
    el("div", { class: "row-aside" }, el("span", { text: from }), el("span", { class: "small", text: left > 0 ? ` · ${left} left` : " · sold out" })));
}
async function eventsView(_, token) {
  setTitle("Events");
  const r = await api("GET", "/api/events");
  if (stale(token)) return;
  const events = r.data.events || [];
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Demo events" }), el("h1", { text: "Events" })), el("p", { text: "Times are Nepal Time (NPT)." })),
    r.status !== 200 ? alertBox(errText(r, "The events did not load.")) : events.length ? el("ul", { class: "rows" }, events.map(eventRow)) : emptyBox("No events are on sale yet.", "Organisers publish events here. Check back soon.")));
}
async function eventView([id], token) {
  const r = await api("GET", `/api/events/${id}`);
  if (stale(token)) return;
  if (r.status === 404) return setMain(el("section", { class: "wrap" }, el("h1", { text: "Event not found" }), el("p", { text: "It may have been removed, or it is not on sale." }), link("/events", "All events", "btn")));
  if (r.status !== 200) return setMain(el("section", { class: "wrap" }, alertBox(errText(r, "The event did not load."))));
  const ev = r.data.event;
  setTitle(ev.name);
  const isOwner = state.user && (state.user.role === "admin" || state.user.id === ev.organiser_id);
  const types = ev.ticket_types || [];
  const qty = new Map(types.map((t) => [t.id, 0]));
  const output = (t) => el("output", { id: `q-${t.id}`, "aria-live": "polite", text: "0" });
  const total = el("p", { class: "summary-line", "aria-live": "polite" });
  const note = el("p", { class: "small pay-note", id: "pay-note" });
  const status = el("div", { role: "status", "aria-live": "polite" });
  const submit = el("button", { type: "submit", class: "btn", text: "Reserve tickets" });
  const updateTotals = () => {
    let sum = 0, count = 0, paid = false;
    for (const t of types) {
      const q = qty.get(t.id); sum += q * t.price_npr; count += q; if (q && t.price_npr > 0) paid = true;
      const out = document.getElementById(`q-${t.id}`); if (out) out.textContent = String(q);
      const plus = document.getElementById(`plus-${t.id}`); if (plus) plus.disabled = q >= Math.min(t.max_per_order, t.remaining);
      const minus = document.getElementById(`minus-${t.id}`); if (minus) minus.disabled = q <= 0;
    }
    total.replaceChildren(el("span", { text: "Total" }), el("span", { class: "num", text: count ? money(sum) : "NPR 0" }));
    note.textContent = count === 0 ? "" : paid
      ? "Payment is pending. Pay at the venue. This demo takes no payment."
      : "Free tickets are issued as soon as you reserve.";
    submit.disabled = count === 0;
  };
  const typeRows = types.map((t) => {
    const soldOut = t.remaining === 0 || !t.on_sale;
    return el("li", { class: "type" },
      el("div", {}, el("div", { class: "type-name", text: t.name }),
        el("div", { class: "type-left", text: !t.on_sale ? "Not on sale" : soldOut ? "Sold out" : `${t.remaining} left · up to ${t.max_per_order} per order` }),
      ),
      el("div", { class: "type-price num", text: money(t.price_npr) }),
      soldOut || !state.user || isOwner ? el("span", { class: "small", text: state.user ? "" : "" }) : el("div", { class: "stepper", role: "group", "aria-label": `Quantity for ${t.name}` },
        el("button", { type: "button", id: `minus-${t.id}`, "aria-label": `Fewer ${t.name}`, text: "−", onclick: () => { qty.set(t.id, Math.max(0, qty.get(t.id) - 1)); updateTotals(); } }),
        output(t),
        el("button", { type: "button", id: `plus-${t.id}`, "aria-label": `More ${t.name}`, text: "+", onclick: () => { qty.set(t.id, Math.min(t.max_per_order, t.remaining, qty.get(t.id) + 1)); updateTotals(); } })));
  });
  let form = null;
  if (!state.user) {
    form = el("div", { class: "notice" }, el("p", { text: "Please log in to continue your purchase." }), link(`/login?next=${encodeURIComponent(location.pathname)}`, "Log in to buy", "btn"));
  } else if (isOwner) {
    form = el("p", { class: "notice", text: "You run this event, so you cannot buy from it here. Use the organiser page to manage it." });
  } else if (state.user.role === "door") {
    form = el("p", { class: "notice", text: "Door staff accounts cannot buy tickets." });
  } else if (types.length === 0) {
    form = el("p", { class: "notice", text: "No tickets have been added to this event yet." });
  } else {
    const key = crypto.randomUUID();
    const name = el("input", { type: "text", id: "buyer_name", name: "buyer_name", autocomplete: "name", required: true, maxlength: 60, value: state.user.name });
    const email = el("input", { type: "email", id: "buyer_email", name: "buyer_email", autocomplete: "email", required: true, maxlength: 254, value: state.user.email });
    const formEl = el("form", { novalidate: true, class: "form-grid two", onsubmit: async (e) => {
      e.preventDefault();
      status.replaceChildren();
      const items = types.map((t) => ({ ticket_type_id: t.id, quantity: qty.get(t.id) })).filter((i) => i.quantity > 0);
      if (!items.length) return status.replaceChildren(alertBox("Choose at least one ticket.", "Not yet."));
      submit.disabled = true; submit.textContent = "Reserving…";
      const r2 = await api("POST", "/api/orders", { event_id: ev.id, items, buyer_name: name.value, buyer_email: email.value, idempotency_key: key });
      if (r2.status === 201 || r2.status === 200) { go(`/orders/${r2.data.order_id}`); return; }
      submit.disabled = false; submit.textContent = "Reserve tickets";
      if (r2.status === 401) return needLogin(location.pathname, "Your log-in ended. Log in again to continue your purchase.");
      status.replaceChildren(alertBox(errText(r2, "The tickets did not reserve. Nothing was charged or held."), r2.status === 409 ? "Sold out." : "Not reserved."));
      if (r2.status === 409) { await refreshEventCounts(ev.id); }
    } },
      el("div", { class: "field" }, el("label", { for: "buyer_name", text: "Name on the tickets" }), name),
      el("div", { class: "field" }, el("label", { for: "buyer_email", text: "Email for the tickets" }), email),
      el("div", { class: "field", style: "grid-column: 1 / -1" }, submit, note),
    );
    form = el("div", {}, formEl, status);
  }
  const counter = el("p", { class: "small", text: `${ev.venue}` });
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("span", { class: "demo-note", text: ev.name.includes("DEMO") ? "Demo event" : "" }), el("h1", { text: ev.name }), el("p", { class: "num", text: npt(ev.starts_at) })), el("p", { text: "" })),
    el("div", { class: "two-col" },
      el("div", {},
        el("p", { class: "lede", text: ev.description || "No description." }),
        counter,
        el("h2", { class: "section-gap", text: "Tickets" }),
        types.length ? el("ul", { class: "types", "aria-label": "Ticket types" }, typeRows) : emptyBox("No ticket types yet.", "The organiser has not added any tickets."),
      ),
      el("div", { class: "side", "aria-label": "Your order" },
        el("h2", { text: "Your order" }),
        types.length && !isOwner && state.user && state.user.role !== "door" ? total : null,
        form,
        el("p", { class: "small", text: "Demo: no payment is taken. Paid tickets show as pending until they are paid at the venue." })),
    ),
  ));
  if (state.user && !isOwner && state.user.role !== "door") updateTotals();
  async function refreshEventCounts(id) {
    const again = await api("GET", `/api/events/${id}`);
    if (again.status === 200) updateCountsOnPage(again.data.event);
  }
  function updateCountsOnPage(newEv) {
    for (const t of newEv.ticket_types) {
      const old = types.find((x) => x.id === t.id);
      if (old) { old.remaining = t.remaining; old.on_sale = t.on_sale; }
    }
    const reset = [...qty.keys()].reduce((o, k) => { o[k] = 0; return o; }, {});
    void reset;
    setTitle(newEv.name);
    eventView([id], token);
  }
}
async function orderView([id], token) {
  const r = await api("GET", `/api/orders/${id}`);
  if (stale(token)) return;
  if (r.status === 401) return needLogin(location.pathname, "Log in to see your tickets.");
  if (r.status === 404) return setMain(el("section", { class: "wrap" }, el("h1", { text: "Order not found" }), el("p", { text: "It may belong to another account." }), link("/tickets", "My tickets", "btn")));
  if (r.status !== 200) return setMain(el("section", { class: "wrap" }, alertBox(errText(r, "The order did not load."))));
  const o = r.data.order;
  setTitle(`Tickets for ${o.event_name}`);
  const payNote = o.payment_status === "free"
    ? "Free tickets. Show a code at the door."
    : "Payment pending. Pay at the venue. This demo takes no payment.";
  const stubs = o.tickets.map((t) => {
    let img = null;
    try { const q = qrcode(0, "M"); q.addData(t.qr); q.make(); img = el("img", { src: q.createDataURL(4, 2), width: 180, height: 180, alt: `QR code for ticket ${t.code}` }); } catch { img = el("p", { class: "small", text: `Code ${t.code}` }); }
    const word = t.status === "valid" ? "Valid" : t.status === "used" ? `Checked in${t.used_at ? " " + nptShort(t.used_at) : ""}` : "Cancelled";
    return el("li", { class: "stub" },
      el("div", { class: "stub-main" },
        el("p", { class: "small", text: t.type_name }),
        el("div", { class: "stub-code num", text: t.code }),
        el("span", { class: `status-word ${t.status}`, text: word }),
        el("p", { class: "small section-gap", text: "Shown at the door. One scan only." })),
      el("div", { class: "stub-qr" }, img));
  });
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Your order" }), el("h1", { text: o.event_name }), el("p", { class: "num", text: npt(o.starts_at) })), el("p", { text: o.venue })),
    el("p", { class: "notice", text: payNote }),
    el("p", { text: `Name on the tickets: ${o.buyer_name}` }),
    el("p", { class: "small", text: `Tickets: ${o.tickets.length} · Total: ${money(o.total_npr)}` }),
    el("ul", { class: "stub-list section-gap", "aria-label": "Tickets" }, stubs),
    el("p", { class: "small section-gap", text: "Demo: made-up event. No payment has been taken and no real entry is granted." }),
  ));
}
async function myTicketsView(_, token) {
  if (!state.user) return needLogin("/tickets", "Log in to see your tickets.");
  setTitle("My tickets");
  const r = await api("GET", "/api/orders");
  if (stale(token)) return;
  if (r.status !== 200) return setMain(el("section", { class: "wrap" }, alertBox(errText(r, "Your tickets did not load."))));
  const orders = r.data.orders || [];
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Your account" }), el("h1", { text: "My tickets" }))),
    orders.length === 0
      ? emptyBox("No tickets yet.", "Once you reserve tickets they appear here with their codes.", link("/events", "Find an event", "btn"))
      : el("ul", { class: "rows" }, orders.map((o) => el("li", { class: "row" },
        el("span", { class: "row-meta num", text: nptShort(o.starts_at) }),
        el("div", {}, el("a", { href: `/orders/${o.id}`, "data-link": "", class: "row-link" }, el("span", { class: "row-title", text: o.event_name })), el("div", { class: "row-meta", text: `${o.tickets} ticket${o.tickets === 1 ? "" : "s"} · ${o.payment_status === "free" ? "Free" : "Pay at the venue (pending)"}` })),
        el("div", { class: "row-aside", text: money(o.total_npr) }))))));
}

// ---------- auth ----------
async function loginView() {
  setTitle("Log in");
  const next = safeNext(new URLSearchParams(location.search).get("next") || "/");
  const status = el("div", { role: "status", "aria-live": "polite" });
  const email = el("input", { type: "email", id: "email", name: "email", autocomplete: "username", required: true, maxlength: 254 });
  const pw = el("input", { type: "password", id: "password", name: "password", autocomplete: "current-password", required: true, maxlength: 128 });
  const submit = el("button", { type: "submit", class: "btn", text: "Log in" });
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Account" }), el("h1", { text: "Log in" }))),
    el("div", { class: "two-col" },
      el("div", {},
        el("form", { novalidate: true, onsubmit: async (e) => {
          e.preventDefault(); status.replaceChildren();
          submit.disabled = true; submit.textContent = "Logging in…";
          const r = await api("POST", "/api/auth/login", { email: email.value, password: pw.value });
          if (r.status === 200) { state.user = r.data.user; await loadSession(); state.user = r.data.user; renderNav(); go(next); return; }
          submit.disabled = false; submit.textContent = "Log in";
          status.replaceChildren(alertBox(errText(r, "Log-in did not work."), r.status === 429 ? "Locked for a while." : "Not logged in."));
        } },
          el("div", { class: "field" }, el("label", { for: "email", text: "Email" }), email),
          el("div", { class: "field" }, el("label", { for: "password", text: "Password" }), pw),
          el("div", { class: "btn-row" }, submit, link(`/register?next=${encodeURIComponent(next)}`, "Create an account", "small")),
          status),
      ),
      el("div", { class: "side" },
        el("h2", { text: "Demo accounts" }),
        el("p", { class: "small", text: "Made-up accounts for trying the app. Demo data only. Use these, or make your own." }),
        el("div", { class: "creds" },
          ...[["Buyer", "buyer@demo.melatickets.example", "DemoBuyer-2026-mela"], ["Organiser", "organiser@demo.melatickets.example", "DemoOrganiser-2026-mela"], ["Door staff", "door@demo.melatickets.example", "DemoDoor-2026-mela"], ["Admin", "admin@demo.melatickets.example", "DemoAdmin-2026-mela"]].map(([role, mail, pass]) =>
            el("div", {}, el("strong", { text: role }), el("code", { text: mail }), el("span", { class: "small" }, "Password: ", el("code", { text: pass }))))),
        el("button", { type: "button", class: "btn ghost small section-gap", text: "Fill buyer demo login", onclick: () => { email.value = "buyer@demo.melatickets.example"; pw.value = "DemoBuyer-2026-mela"; email.focus(); } }),
      ),
    ),
  ));
}
async function registerView() {
  setTitle("Sign up");
  const params = new URLSearchParams(location.search);
  const next = safeNext(params.get("next") || "/");
  const status = el("div", { role: "status", "aria-live": "polite" });
  const name = el("input", { type: "text", id: "name", name: "name", autocomplete: "name", required: true, maxlength: 60 });
  const email = el("input", { type: "email", id: "email", name: "email", autocomplete: "email", required: true, maxlength: 254 });
  const pw = el("input", { type: "password", id: "password", name: "password", autocomplete: "new-password", required: true, minlength: 10, maxlength: 128, "aria-describedby": "pw-hint" });
  const org = el("input", { type: "checkbox", id: "organiser", name: "organiser", ...(params.get("organiser") ? { checked: true } : {}) });
  const submit = el("button", { type: "submit", class: "btn", text: "Create account" });
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Account" }), el("h1", { text: "Sign up" }))),
    el("form", { novalidate: true, class: "two-col", onsubmit: async (e) => {
      e.preventDefault(); status.replaceChildren();
      submit.disabled = true; submit.textContent = "Creating…";
      const r = await api("POST", "/api/auth/register", { name: name.value, email: email.value, password: pw.value, organiser: org.checked });
      if (r.status === 201) { state.user = r.data.user; renderNav(); go(next); return; }
      submit.disabled = false; submit.textContent = "Create account";
      status.replaceChildren(alertBox(errText(r, "The account was not made."), "Not created."));
    } },
      el("div", {},
        el("div", { class: "field" }, el("label", { for: "name", text: "Your name" }), name),
        el("div", { class: "field" }, el("label", { for: "email", text: "Email" }), email),
        el("div", { class: "field" }, el("label", { for: "password", text: "Password" }), el("span", { class: "hint", id: "pw-hint", text: "At least 10 characters." }), pw),
        el("div", { class: "field" }, el("label", { class: "check", for: "organiser" }, org, el("span", { text: "I run events and want to publish tickets. (Organiser account)" }))),
        el("div", { class: "btn-row" }, submit),
        status),
      el("div", { class: "side" }, el("p", { class: "small", text: "Buyers can reserve tickets right away. Organiser accounts can publish events. Door staff accounts are made by the admin. Demo only: this site takes no payment." }), el("p", { class: "small", text: "Your name and email are kept to run your tickets. See the Privacy page." })),
    ),
  ));
}

// ---------- organiser ----------
async function organiserListView(_, token) {
  if (!state.user) return needLogin("/organiser", "Log in as an organiser to manage events.");
  if (!can("organiser", "admin")) return denied("Organiser accounts publish events. Your account is not one.");
  setTitle("Organiser");
  const r = await api("GET", "/api/organiser/events");
  if (stale(token)) return;
  const events = r.data.events || [];
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Organiser" }), el("h1", { text: "Your events" })), link("/organiser/new", "New event", "btn")),
    r.status !== 200 ? alertBox(errText(r, "Your events did not load.")) : events.length === 0
      ? emptyBox("No events yet.", "Create an event, add ticket types, then publish it.", link("/organiser/new", "New event", "btn"))
      : el("ul", { class: "rows" }, events.map((ev) => {
        const sold = ev.ticket_types.reduce((s, t) => s + (t.capacity - t.remaining), 0);
        const cap = ev.ticket_types.reduce((s, t) => s + t.capacity, 0);
        return el("li", { class: "row" },
          el("span", { class: "row-meta num", text: nptShort(ev.starts_at) }),
          el("div", {}, el("a", { href: `/organiser/events/${ev.id}`, "data-link": "", class: "row-link" }, el("span", { class: "row-title", text: ev.name })), el("div", { class: "row-meta", text: `${ev.venue} · ${ev.status}` })),
          el("div", { class: "row-aside num", text: `${sold} of ${cap} sold` }));
      }))));
}
async function newEventView(_, token) {
  if (!state.user) return needLogin("/organiser/new", "Log in as an organiser to create an event.");
  if (!can("organiser", "admin")) return denied("Organiser accounts create events.");
  setTitle("New event");
  const status = el("div", { role: "status", "aria-live": "polite" });
  const f = {
    name: el("input", { type: "text", id: "name", required: true, maxlength: 100 }),
    venue: el("input", { type: "text", id: "venue", required: true, maxlength: 160, placeholder: "Demo venues only, for example a made-up hall" }),
    starts: el("input", { type: "datetime-local", id: "starts", required: true }),
    description: el("textarea", { id: "description", maxlength: 1000 }),
    status: el("select", { id: "status" }, el("option", { value: "draft", text: "Draft (not visible to buyers)" }), el("option", { value: "published", text: "Published (on sale now)" })),
  };
  const submit = el("button", { type: "submit", class: "btn", text: "Create event" });
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Organiser" }), el("h1", { text: "New event" }))),
    el("form", { novalidate: true, class: "two-col", onsubmit: async (e) => {
      e.preventDefault(); status.replaceChildren(); submit.disabled = true;
      const r = await api("POST", "/api/organiser/events", { name: f.name.value, venue: f.venue.value, starts_at: f.starts.value, description: f.description.value, status: f.status.value });
      if (r.status === 201) return go(`/organiser/events/${r.data.event_id}`);
      submit.disabled = false;
      status.replaceChildren(alertBox(errText(r, "The event was not saved.")));
    } },
      el("div", {},
        el("div", { class: "field" }, el("label", { for: "name", text: "Event name" }), f.name),
        el("div", { class: "field" }, el("label", { for: "venue", text: "Venue" }), f.venue),
        el("div", { class: "field" }, el("label", { for: "starts", text: "Starts (Nepal Time, NPT)" }), f.starts),
        el("div", { class: "field" }, el("label", { for: "description", text: "About the event" }), f.description),
        el("div", { class: "field" }, el("label", { for: "status", text: "Status" }), f.status),
        el("div", { class: "btn-row" }, submit),
        status),
      el("div", { class: "side" }, el("p", { class: "small", text: "Add ticket types on the next screen. A demo event is fine: use made-up names and a made-up venue." }))),
  ));
  void token;
}
async function organiserEventView([id], token) {
  if (!state.user) return needLogin(`/organiser/events/${id}`, "Log in as an organiser to manage this event.");
  if (!can("organiser", "admin")) return denied("Organiser accounts manage events.");
  const r = await api("GET", `/api/organiser/events/${id}`);
  if (stale(token)) return;
  if (r.status === 404) return setMain(el("section", { class: "wrap" }, el("h1", { text: "Event not found" }), link("/organiser", "Your events", "btn")));
  if (r.status !== 200) return setMain(el("section", { class: "wrap" }, alertBox(errText(r, "The event did not load."))));
  const { event: ev, staff, orders, checked_in } = r.data;
  setTitle(ev.name);
  const sold = ev.ticket_types.reduce((s, t) => s + (t.capacity - t.remaining), 0);
  const cap = ev.ticket_types.reduce((s, t) => s + t.capacity, 0);
  const panels = {};
  const tabs = ["Details", "Tickets", "Door staff", "Orders"];
  const bar = el("div", { class: "segmented", role: "group", "aria-label": "Event sections" });
  const show = (name) => {
    for (const [k, node] of Object.entries(panels)) node.hidden = k !== name;
    [...bar.children].forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === name)));
  };
  for (const t of tabs) bar.append(el("button", { type: "button", "aria-pressed": "false", text: t, onclick: () => show(t) }));
  const msg = el("div", { role: "status", "aria-live": "polite" });

  // Details
  const dName = el("input", { type: "text", id: "d-name", value: ev.name, maxlength: 100, required: true });
  const dVenue = el("input", { type: "text", id: "d-venue", value: ev.venue, maxlength: 160, required: true });
  const dStarts = el("input", { type: "datetime-local", id: "d-starts", value: nptInputValue(ev.starts_at), required: true });
  const dDesc = el("textarea", { id: "d-desc", maxlength: 1000 }, ev.description);
  const dStatus = el("select", { id: "d-status" }, ...["draft", "published", "closed"].map((s) => el("option", { value: s, text: s, ...(s === ev.status ? { selected: true } : {}) })));
  panels["Details"] = el("form", { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); msg.replaceChildren();
    const rr = await api("PUT", `/api/organiser/events/${ev.id}`, { name: dName.value, venue: dVenue.value, starts_at: dStarts.value, description: dDesc.value, status: dStatus.value });
    if (rr.status === 200) { msg.replaceChildren(el("p", { class: "notice", text: "Saved." })); return; }
    msg.replaceChildren(alertBox(errText(rr, "Not saved.")));
  } },
    el("div", { class: "form-grid two" },
      el("div", { class: "field" }, el("label", { for: "d-name", text: "Event name" }), dName),
      el("div", { class: "field" }, el("label", { for: "d-venue", text: "Venue" }), dVenue),
      el("div", { class: "field" }, el("label", { for: "d-starts", text: "Starts (NPT)" }), dStarts),
      el("div", { class: "field" }, el("label", { for: "d-status", text: "Status" }), dStatus)),
    el("div", { class: "field" }, el("label", { for: "d-desc", text: "About the event" }), dDesc),
    el("div", { class: "btn-row" }, el("button", { type: "submit", class: "btn", text: "Save details" }), link(`/door/${ev.id}`, "Open the door screen", "small")),
    msg);

  // Tickets
  const typeForms = ev.ticket_types.map((t) => {
    const tn = el("input", { type: "text", value: t.name, maxlength: 60, "aria-label": "Ticket name" });
    const tp = el("input", { type: "number", value: String(t.price_npr), min: 0, step: 1, "aria-label": "Price in NPR" });
    const tc = el("input", { type: "number", value: String(t.capacity), min: 0, step: 1, "aria-label": "Capacity" });
    const tm = el("input", { type: "number", value: String(t.max_per_order), min: 1, max: 10, step: 1, "aria-label": "Limit per order" });
    const ts = el("input", { type: "checkbox", ...(t.on_sale ? { checked: true } : {}) });
    const tmsg = el("p", { class: "small", role: "status" });
    return el("form", { class: "type", novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); tmsg.textContent = "";
      const rr = await api("PUT", `/api/organiser/ticket-types/${t.id}`, { name: tn.value, price_npr: Number(tp.value), capacity: Number(tc.value), max_per_order: Number(tm.value), on_sale: ts.checked });
      tmsg.textContent = rr.status === 200 ? "Saved." : (errText(rr, "Not saved."));
    } },
      el("div", { class: "inline-form" },
        el("div", { class: "field" }, el("label", { class: "small", text: "Name" }), tn),
        el("div", { class: "field" }, el("label", { class: "small", text: "Price (NPR, 0 = free)" }), tp),
        el("div", { class: "field" }, el("label", { class: "small", text: "Capacity" }), tc),
        el("div", { class: "field" }, el("label", { class: "small", text: "Per order" }), tm),
        el("label", { class: "check" }, ts, el("span", { text: "On sale" }))),
      el("div", { class: "btn-row" }, el("button", { type: "submit", class: "btn small", text: "Save" }), el("span", { class: "small muted", text: `${t.capacity - t.remaining} issued` })),
      tmsg);
  });
  const addName = el("input", { type: "text", maxlength: 60, required: true, id: "new-type-name" });
  const addPrice = el("input", { type: "number", min: 0, step: 1, value: "0", id: "new-type-price" });
  const addCap = el("input", { type: "number", min: 1, step: 1, value: "50", id: "new-type-cap" });
  const addMax = el("input", { type: "number", min: 1, max: 10, step: 1, value: "4", id: "new-type-max" });
  panels["Tickets"] = el("div", {},
    typeForms.length ? el("div", { class: "section-gap" }, typeForms) : emptyBox("No ticket types yet.", "Add one below. A free type is fine for a demo."),
    el("h2", { class: "section-gap", text: "Add a ticket type" }),
    el("form", { novalidate: true, class: "inline-form", onsubmit: async (e) => {
      e.preventDefault(); msg.replaceChildren();
      const rr = await api("POST", `/api/organiser/events/${ev.id}/ticket-types`, { name: addName.value, price_npr: Number(addPrice.value), capacity: Number(addCap.value), max_per_order: Number(addMax.value) });
      if (rr.status === 201) return org_reload();
      msg.replaceChildren(alertBox(errText(rr, "Not added.")));
    } },
      el("div", { class: "field" }, el("label", { for: "new-type-name", text: "Name" }), addName),
      el("div", { class: "field" }, el("label", { for: "new-type-price", text: "Price (NPR, 0 = free)" }), addPrice),
      el("div", { class: "field" }, el("label", { for: "new-type-cap", text: "Capacity" }), addCap),
      el("div", { class: "field" }, el("label", { for: "new-type-max", text: "Per order" }), addMax),
      el("div", { class: "field" }, el("button", { type: "submit", class: "btn", text: "Add type" }))),
    msg);

  // Door staff
  const staffEmail = el("input", { type: "email", id: "staff-email", maxlength: 254, required: true });
  const staffMsg = el("div", { role: "status", "aria-live": "polite" });
  panels["Door staff"] = el("div", {},
    staff.length ? el("ul", { class: "rows" }, staff.map((s) => el("li", { class: "row", style: "grid-template-columns: 1fr auto" },
      el("div", {}, el("strong", { text: s.name }), el("div", { class: "row-meta", text: s.email })),
      el("button", { type: "button", class: "btn ghost small", text: "Remove", onclick: async () => {
        const rr = await api("POST", `/api/organiser/events/${ev.id}/staff/remove`, { user_id: s.id });
        if (rr.status === 200) org_reload(); else staffMsg.replaceChildren(alertBox(errText(rr, "Not removed.")));
      } })))) : emptyBox("No door staff yet.", "Add the email of a door staff account. The admin creates those accounts."),
    el("form", { class: "inline-form section-gap", novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); staffMsg.replaceChildren();
      const rr = await api("POST", `/api/organiser/events/${ev.id}/staff`, { email: staffEmail.value });
      if (rr.status === 201) return org_reload();
      staffMsg.replaceChildren(alertBox(errText(rr, "Not added."), "Not added."));
    } },
      el("div", { class: "field" }, el("label", { for: "staff-email", text: "Door staff email" }), staffEmail),
      el("div", { class: "field" }, el("button", { type: "submit", class: "btn", text: "Add to door team" }))),
    staffMsg);

  // Orders
  panels["Orders"] = orders.length === 0
    ? emptyBox("No orders yet.", "Orders appear here when buyers reserve tickets.")
    : el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { text: "Buyer" }), el("th", { text: "Email" }), el("th", { text: "Payment" }), el("th", { class: "num", text: "Tickets" }), el("th", { class: "num", text: "Checked in" }))),
      el("tbody", {}, orders.map((o) => el("tr", {},
        el("td", { text: o.buyer_name }), el("td", { text: o.buyer_email }),
        el("td", { text: o.payment_status === "free" ? "Free" : `Pending · ${money(o.total_npr)}` }),
        el("td", { class: "num", text: String(o.tickets) }), el("td", { class: "num", text: String(o.used) }))))));

  for (const k of Object.keys(panels)) panels[k].hidden = true;
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Event" }), el("h1", { text: ev.name }), el("p", { class: "num", text: npt(ev.starts_at) })), el("span", { class: "status-word", text: ev.status })),
    el("dl", { class: "stats" },
      el("div", {}, el("dt", { text: "Capacity" }), el("dd", { class: "num", text: String(cap) })),
      el("div", {}, el("dt", { text: "Issued" }), el("dd", { class: "num", text: String(sold) })),
      el("div", {}, el("dt", { text: "Checked in" }), el("dd", { class: "num", text: String(checked_in) })),
      el("div", {}, el("dt", { text: "Orders" }), el("dd", { class: "num", text: String(orders.length) }))),
    el("div", { class: "bar", role: "img", "aria-label": `${sold} of ${cap} tickets issued` }, el("span", { style: `width:${cap ? Math.min(100, (sold / cap) * 100) : 0}%` })),
    el("div", { class: "section-gap" }, bar),
    ...tabs.map((t) => panels[t]),
  ));
  show("Details");
  async function org_reload() { await organiserEventView([id], state.token); }
  void token;
}

// ---------- door ----------
async function doorListView(_, token) {
  if (!state.user) return needLogin("/door", "Log in with a door staff account.");
  if (!can("door", "organiser", "admin")) return denied("The door screen is for door staff, organisers and admins.");
  setTitle("Door");
  const r = await api("GET", "/api/door/events");
  if (stale(token)) return;
  const events = r.data.events || [];
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Door" }), el("h1", { text: "Choose an event" }))),
    r.status !== 200 ? alertBox(errText(r, "Events did not load.")) : events.length === 0
      ? emptyBox("No events on your door team.", "Ask the organiser to add your email to the door team for an event.")
      : el("ul", { class: "rows" }, events.map((ev) => el("li", { class: "row" },
        el("span", { class: "row-meta num", text: nptShort(ev.starts_at) }),
        el("div", {}, el("a", { href: `/door/${ev.id}`, "data-link": "", class: "row-link" }, el("span", { class: "row-title", text: ev.name })), el("div", { class: "row-meta", text: ev.venue })),
        el("span", { class: "status-word", text: ev.status }))))));
}
async function doorEventView([id], token) {
  if (!state.user) return needLogin(`/door/${id}`, "Log in with a door staff account.");
  if (!can("door", "organiser", "admin")) return denied("The door screen is for door staff, organisers and admins.");
  const r = await api("GET", `/api/door/events/${id}`);
  if (stale(token)) return;
  if (r.status === 403) return denied("You are not on the door team for this event.");
  if (r.status === 404) return setMain(el("section", { class: "wrap" }, el("h1", { text: "Event not found" }), link("/door", "Choose an event", "btn")));
  if (r.status !== 200) return setMain(el("section", { class: "wrap" }, alertBox(errText(r, "The door screen did not load."))));
  const { event: ev } = r.data;
  setTitle(`Door · ${ev.name}`);

  const board = el("div", { class: "gate-board idle", role: "status", "aria-live": "assertive" }, el("p", { class: "verdict", text: "Ready" }), el("p", { class: "small", text: "Type the code from the ticket, or scan its QR." }));
  const codeInput = el("input", { type: "text", id: "code", name: "code", autocomplete: "off", autocapitalize: "characters", spellcheck: false, inputmode: "text", maxlength: 12, "aria-label": "Ticket code", placeholder: "7KQ4-M9TR", required: true });
  const scanBox = el("div", { class: "scanner", hidden: true });
  const statsBox = el("div", {});
  const recentBox = el("div", {});
  const scanBtn = el("button", { type: "button", class: "btn ghost", text: "Scan QR", hidden: true, onclick: () => startScan() });
  const noScan = el("p", { class: "small", id: "noscan", text: "This browser cannot scan here. Type the code from the ticket." });
  let scanning = null;

  function show(outcome, title, text, cls) {
    board.className = `gate-board ${cls}`;
    board.replaceChildren(el("p", { class: "verdict", text: title }), el("p", { class: "small", text }));
    void outcome;
  }
  async function refresh() {
    const rr = await api("GET", `/api/door/events/${ev.id}`);
    if (rr.status !== 200) return;
    const total = rr.data.types.reduce((s, t) => s + t.capacity, 0);
    const used = rr.data.types.reduce((s, t) => s + t.used, 0);
    const issued = rr.data.types.reduce((s, t) => s + t.issued, 0);
    statsBox.replaceChildren(el("dl", { class: "stats" },
      el("div", {}, el("dt", { text: "Checked in" }), el("dd", { class: "num", text: String(used) })),
      el("div", {}, el("dt", { text: "Tickets issued" }), el("dd", { class: "num", text: String(issued) })),
      el("div", {}, el("dt", { text: "Capacity" }), el("dd", { class: "num", text: String(total) })),
      el("div", {}, el("dt", { text: "Still to come" }), el("dd", { class: "num", text: String(Math.max(0, issued - used)) }))));
    recentBox.replaceChildren(rr.data.recent.length
      ? el("ul", { class: "rows", "aria-label": "Last check-ins" }, rr.data.recent.map((x) => el("li", { class: "row", style: "grid-template-columns: 1fr auto" },
        el("div", {}, el("strong", { text: x.buyer_name }), el("div", { class: "row-meta", text: x.type_name })), el("span", { class: "num small", text: `${x.code} · ${nptShort(x.used_at)}` }))))
      : el("p", { class: "small", text: "No check-ins yet." }));
    return rr.data;
  }
  async function check(raw) {
    const code = String(raw || "").trim();
    if (!code) return show("empty", "Type a code", "Codes are 8 characters.", "idle");
    show("busy", "Checking…", "", "idle");
    const rr = await api("POST", "/api/door/checkin", { event_id: ev.id, code });
    const d = rr.data || {};
    if (rr.status === 200 && d.result === "valid") {
      show("valid", "Valid · let in", `${d.ticket.buyer_name} · ${d.ticket.type_name} · ${d.ticket.code}`, "valid");
    } else if (d.result === "already_used") {
      show("used", "Already used", `Checked in ${d.used_at ? nptShort(d.used_at) : "earlier"}. Do not let this one in.`, "refused");
    } else if (d.result === "wrong_event") {
      show("wrong", "Wrong event", "This ticket is for a different event.", "refused");
    } else if (d.result === "not_found") {
      show("missing", "Not found", "No ticket has that code. Check the code and try again.", "refused");
    } else if (d.result === "void") {
      show("void", "Cancelled", "This ticket was cancelled.", "refused");
    } else if (rr.status === 422) {
      show("bad", "Code not read", d.message || "Codes are 8 characters.", "idle");
    } else if (rr.status === 401 || rr.status === 403) {
      show("denied", "Not allowed", "This account is not on the door team for this event.", "refused");
    } else {
      show("error", "Not checked", "No connection or a server error. The ticket was not marked. Try again.", "idle");
    }
    codeInput.value = ""; codeInput.focus();
    await refresh();
  }
  async function startScan() {
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (scanning) return stopScan();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      const video = el("video", { playsinline: true, muted: true, "aria-label": "Camera for scanning" });
      video.srcObject = stream;
      scanBox.replaceChildren(video, el("p", { class: "small", text: "Point the camera at the QR code." }));
      scanBox.hidden = false;
      await video.play();
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      let done = false;
      const stop = () => { done = true; stream.getTracks().forEach((t) => t.stop()); scanBox.hidden = true; scanBox.replaceChildren(); scanning = null; scanBtn.textContent = "Scan QR"; };
      scanning = { stop };
      scanBtn.textContent = "Stop scanning";
      const tick = async () => {
        if (done) return;
        try {
          const found = await detector.detect(video);
          if (found.length) { stop(); return check(found[0].rawValue); }
        } catch { /* keep trying */ }
        setTimeout(tick, 250);
      };
      tick();
    } catch {
      scanBox.hidden = true;
      show("camera", "No camera", "Camera access was refused or is not available. Type the code instead.", "idle");
    }
  }
  function stopScan() { if (scanning) scanning.stop(); }

  if ("BarcodeDetector" in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) scanBtn.hidden = false; else noScan.hidden = false;
  const entry = el("form", { class: "gate-input", novalidate: true, onsubmit: (e) => { e.preventDefault(); check(codeInput.value); } },
    el("label", { for: "code", class: "label", text: "Ticket code" }),
    codeInput,
    el("div", { class: "btn-row" }, el("button", { type: "submit", class: "btn", text: "Check in" }), scanBtn),
    noScan);
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Door" }), el("h1", { text: ev.name }), el("p", { class: "num", text: npt(ev.starts_at) })), el("span", { class: "status-word", text: ev.status })),
    el("div", { class: "two-col" },
      el("div", {}, entry, board, scanBox),
      el("div", {}, statsBox, el("h2", { text: "Last check-ins" }), recentBox)),
    el("p", { class: "small section-gap", text: "A ticket can be used once. A second scan is refused." })));
  await refresh();
  if (stale(token)) return;
  codeInput.focus();
}

// ---------- admin ----------
async function adminView(_, token) {
  if (!state.user) return needLogin("/admin", "Log in with an admin account.");
  if (!can("admin")) return denied("The admin area is for admin accounts.");
  setTitle("Admin");
  const [ov, users, events, audit] = await Promise.all([
    api("GET", "/api/admin/overview"), api("GET", "/api/admin/users"), api("GET", "/api/admin/events"), api("GET", "/api/admin/audit"),
  ]);
  if (stale(token)) return;
  const msg = el("div", { role: "status", "aria-live": "polite" });
  const roleOf = (n, arr, key) => (arr || []).find((x) => x.role === n || x.status === n || x.payment_status === n)?.[key] ?? 0;
  const counts = ov.status === 200 ? el("dl", { class: "stats" },
    el("div", {}, el("dt", { text: "Accounts" }), el("dd", { class: "num", text: String((ov.data.roles || []).reduce((s, r) => s + Number(r.n), 0)) })),
    el("div", {}, el("dt", { text: "Events" }), el("dd", { class: "num", text: String((ov.data.events || []).reduce((s, r) => s + Number(r.n), 0)) })),
    el("div", {}, el("dt", { text: "Tickets issued" }), el("dd", { class: "num", text: String((ov.data.tickets || []).filter((t) => t.status !== "void").reduce((s, r) => s + Number(r.n), 0)) })),
    el("div", {}, el("dt", { text: "Checked in" }), el("dd", { class: "num", text: String(roleOf("used", ov.data.tickets, "n")) }))) : alertBox(errText(ov, "Overview did not load."));
  const roleSel = (u) => {
    const s = el("select", { "aria-label": `Role for ${u.name}` }, ["buyer", "organiser", "door", "admin"].map((r) => el("option", { value: r, text: r, ...(r === u.role ? { selected: true } : {}) })));
    return el("div", { class: "btn-row" }, s, el("button", { type: "button", class: "btn small ghost", text: "Save role", onclick: async () => {
      const rr = await api("POST", `/api/admin/users/${u.id}/role`, { role: s.value });
      msg.replaceChildren(rr.status === 200 ? el("p", { class: "notice", text: `Saved for ${u.name}.` }) : alertBox(errText(rr, "Not saved."), "Not saved."));
      if (rr.status === 200) go("/admin");
    } }));
  };
  const userRows = users.status === 200 ? users.data.users : [];
  const newName = el("input", { type: "text", id: "nu-name", maxlength: 60 });
  const newMail = el("input", { type: "email", id: "nu-email", maxlength: 254 });
  const newPass = el("input", { type: "password", id: "nu-pass", maxlength: 128, minlength: 10, autocomplete: "new-password" });
  const newRole = el("select", { id: "nu-role" }, ["door", "organiser", "buyer", "admin"].map((r) => el("option", { value: r, text: r })));
  const eventRows = events.status === 200 ? events.data.events : [];
  const auditRows = audit.status === 200 ? audit.data.entries : [];
  setMain(el("section", { class: "wrap" },
    el("div", { class: "page-head" }, el("div", {}, el("p", { class: "kicker", text: "Admin" }), el("h1", { text: "Admin" }))),
    counts,
    el("h2", { class: "section-gap", text: "Users and roles" }),
    msg,
    userRows.length ? el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { text: "Name" }), el("th", { text: "Email" }), el("th", { text: "Role" }))),
      el("tbody", {}, userRows.map((u) => el("tr", {}, el("td", { text: u.name }), el("td", { text: u.email }), el("td", {}, roleSel(u))))))) : emptyBox("No accounts.", ""),
    el("h3", { class: "section-gap", text: "Make a door staff account" }),
    el("form", { class: "inline-form", novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); msg.replaceChildren();
      const rr = await api("POST", "/api/admin/users", { name: newName.value, email: newMail.value, password: newPass.value, role: newRole.value });
      if (rr.status === 201) return go("/admin");
      msg.replaceChildren(alertBox(errText(rr, "Not created."), "Not created."));
    } },
      el("div", { class: "field" }, el("label", { for: "nu-name", text: "Name" }), newName),
      el("div", { class: "field" }, el("label", { for: "nu-email", text: "Email" }), newMail),
      el("div", { class: "field" }, el("label", { for: "nu-pass", text: "Password (10+)" }), newPass),
      el("div", { class: "field" }, el("label", { for: "nu-role", text: "Role" }), newRole),
      el("div", { class: "field" }, el("button", { type: "submit", class: "btn", text: "Create account" }))),
    el("h2", { class: "section-gap", text: "Events" }),
    eventRows.length ? el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { text: "Event" }), el("th", { text: "Status" }), el("th", { class: "num", text: "Sold" }), el("th", { class: "num", text: "Capacity" }))),
      el("tbody", {}, eventRows.map((ev) => el("tr", {}, el("td", { text: ev.name }), el("td", { text: ev.status }),
        el("td", { class: "num", text: String(ev.ticket_types.reduce((s, t) => s + (t.capacity - t.remaining), 0)) }),
        el("td", { class: "num", text: String(ev.ticket_types.reduce((s, t) => s + t.capacity, 0)) })))))) : emptyBox("No events.", ""),
    el("h2", { class: "section-gap", text: "Audit log" }),
    auditRows.length ? el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { text: "When" }), el("th", { text: "Who" }), el("th", { text: "Action" }))),
      el("tbody", {}, auditRows.map((a) => el("tr", {}, el("td", { class: "num", text: nptShort(Number(a.created_at)) }), el("td", { text: a.actor || "system" }), el("td", { text: a.action })))))) : emptyBox("No entries yet.", ""),
  ));
}

// ---------- legal ----------
function termsView() {
  setTitle("Terms");
  setMain(el("section", { class: "wrap legal" },
    el("div", { class: "page-head" }, el("div", {}, el("h1", { text: "Terms of use" }))),
    el("p", { text: "Mela Tickets is a demo. Events, venues, people and tickets on this site are made up. No real ticket is sold and no real entry is granted." }),
    el("h2", { text: "Payments" }), el("p", { text: "This demo takes no payment. Paid ticket types show the amount and a status of pending: pay at the venue, which is not part of this demo. Nothing is charged to a card or wallet." }),
    el("h2", { text: "Accounts" }), el("p", { text: "You must give a real name and email to make an account. Keep your password private. Organisers are responsible for their events. Door staff must use only their own account." }),
    el("h2", { text: "Tickets" }), el("p", { text: "A ticket is valid for one check-in. Capacity is enforced by the database, so a ticket type cannot be sold beyond its capacity. A checked-in ticket cannot be used again." }),
    el("h2", { text: "Acceptable use" }), el("p", { text: "Do not try to break the site, read other people's tickets or orders, or check in tickets you are not authorised to scan." }),
    el("h2", { text: "Changes and contact" }), el("p", { text: "This is a portfolio demo and may change or be reset at any time. For questions, contact the operator through the repository linked from the project page." }),
    el("p", { class: "small", text: "Read the Privacy page for what data is kept." })));
}
function privacyView() {
  setTitle("Privacy");
  setMain(el("section", { class: "wrap legal" },
    el("div", { class: "page-head" }, el("div", {}, el("h1", { text: "Privacy" }))),
    el("p", { text: "This page says what the demo stores and why." }),
    el("h2", { text: "What is stored" }), el("ul", {},
      el("li", { text: "Account: name, email, and a password hash (PBKDF2-SHA256, never the password itself)." }),
      el("li", { text: "Orders and tickets: the name and email you enter for the tickets, the event, the ticket type, and whether it was checked in and when." }),
      el("li", { text: "Security: a session token (stored only as a hash), and counts of failed log-ins and sign-ups per address for rate limits, cleared after 15 minutes or one hour." }),
      el("li", { text: "Audit log: what changed and who changed it (a role change, a check-in, an order)." })),
    el("h2", { text: "What is not stored" }), el("p", { text: "No card or wallet details, no payment records, no phone number, no location, no advertising or tracking cookies." }),
    el("h2", { text: "Cookies" }), el("p", { text: "One session cookie (HttpOnly, Secure, SameSite=Lax) keeps you logged in for up to 12 hours. One CSRF cookie (HttpOnly, Secure, SameSite=Strict) protects forms. Both are needed for the site to work." }),
    el("h2", { text: "Who sees it" }), el("p", { text: "Organisers see the buyers on their own events. Admins see accounts and the audit log. Door staff see check-in counts and the names on tickets they scan." }),
    el("h2", { text: "Your choices" }), el("p", { text: "Ask the operator through the repository to delete your account and tickets. Demo data may be reset at any time." }),
    el("p", { class: "small", text: "Demo: no real personal data should be entered." })));
}

// ---------- boot ----------
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href='#main']");
  if (a) { e.preventDefault(); app.focus(); }
});
const foot = document.getElementById("foot-year");
if (foot) foot.textContent = String(new Date().getUTCFullYear());
loadSession().then(() => route());
