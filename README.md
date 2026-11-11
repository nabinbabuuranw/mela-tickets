# Mela Tickets

A demo event-ticketing app for Nepal. Organisers publish events and ticket types,
buyers get QR tickets, capacity cannot be oversold, and door staff check people in
on a phone.

This is a demonstration. It has no real payments, no real events, no email
verification and no buyer cancellations. All events, accounts and orders in the
demo are made up.

Live demo: https://mela-tickets.sites.tab.bot/

## Demo accounts

The login page lists four demo accounts (buyer, organiser, door staff, admin) with
their passwords. They exist only in the demo database.

## What it does

- Public event pages with ticket types and remaining capacity.
- Buyer reserves tickets; each ticket gets a QR code and a short code.
- Organiser creates and publishes events, sets capacity, adds door staff.
- Door screen scans or types a code and says LET IN, ALREADY USED, WRONG EVENT,
  NOT FOUND or VOID. Each valid ticket is admitted once.
- Capacity is enforced inside the database in the same transaction as the order,
  with SQLite triggers, so two buyers cannot take the last seat.

## Stack

- One Cloudflare Worker (`site/_worker.js`) with a D1 binding named `DB`.
- Vanilla JavaScript single-page app (`site/app.js`, `site/app.css`), no framework,
  no build step.
- Vendored QR encoder: `site/vendor/qrcode.mjs` (qrcode-generator 2.0.4, MIT,
  Kazuhiko Arase).
- Fonts: Anton and Yantramanav, both under the SIL Open Font License, self-hosted
  as Latin and Devanagari subsets in `site/fonts/`.

Security: PBKDF2-SHA256 password hashing (100,000 iterations), HttpOnly, Secure,
SameSite=Lax session cookie, double-submit CSRF token plus Origin check, and a
strict Content-Security-Policy with no inline scripts or styles.

## Run the tests

    npm test

The suite has 59 tests. They run the Worker's API against an in-memory D1
stand-in built on `node:sqlite` (Node 22.5 or newer is required).

## Run it locally

    node tools/local-server.mjs

The local server runs the same Worker over an in-memory database and serves
`site/`. It is for development and QA only.

## Browser QA

    pip install playwright                          # plus Chromium: playwright install chromium
    npm install axe-core                            # gives node_modules/axe-core/axe.min.js
    node tools/local-server.mjs &                    # serves on 127.0.0.1:8787
    AXE_JS=node_modules/axe-core/axe.min.js python3 qa/browser_qa.py <out-dir> 375   # also 768, 1024, 1440

The script opens 23 pages per width against the local server, checks horizontal overflow, console and page
errors, failed responses, broken links, and runs an axe accessibility scan. The
full results used for the QA report are in QA_REPORT.md in the delivery folder.

## Deploy

`site/tab-site.json` declares the Worker entry and the D1 binding. Any Cloudflare
account with a D1 database bound as `DB` can run it. The tables are created on the
first request if they are missing.

## Known limits

- QR scanning on the door screen uses the browser's BarcodeDetector API where it
  exists. It was not testable in headless Chromium; typing a code always works.
- Demo passwords are published on the login page on purpose. Do not reuse this
  code for real accounts without removing them.
- No payments, no receipts, no refunds, no buyer cancellation, no email.

## Licence

MIT. See LICENSE. Third-party files keep their own licences (see the headers in
`site/vendor/qrcode.mjs` and `site/fonts/`).
