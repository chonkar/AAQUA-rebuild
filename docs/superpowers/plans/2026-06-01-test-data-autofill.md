# Test-Data Autofill (AAQUA-Integrated)

Status: **Plan only — not started.** Drafted 2026-06-01. Supersedes the earlier plugin-based draft.

## Goal

Give testers a one-click way to fill any web form with coherent, project-appropriate test data — delivered as an **AAQUA page**, not a browser extension. Tester enters the URL of the form they want to test; AAQUA opens it in a server-side Playwright browser, AI maps each field to a semantic meaning, returns a filled-form preview plus reusable Playwright code. Automation engineers walk away with code; manual testers walk away with a copy-paste-able value list.

The earlier plugin draft is superseded because:
- 3× faster to ship (2–3 days vs 8 days).
- No Chrome Web Store / Manifest V3 / per-update reinstall churn.
- No new auth surface (reuses Keycloak).
- Works on cross-origin iframes — Stripe checkout, OAuth screens, the highest-value forms — which a content-script plugin literally cannot reach.
- Output is reusable Playwright code, not a one-shot fill.

## What already exists (reuse, don't rebuild)

- **Playwright-as-library** — `/api/browser/launch|capture|close`, `/api/scrape`, `/api/analyze-localization`, `/api/analyze-accessibility` all already spin up server-side Playwright. New endpoint piggybacks on the same setup, including `HEADLESS=false` toggle for the dev cookie-capture flow.
- **Test Data Generator** — `src/pages/TestDataGenerator.jsx`, `src/services/testDataService.js`. LLM-driven, labeled data sets. The data source the new page pulls from.
- **LLM client** — `server/utils/llmClient.js`. The field-semantics mapping call goes through this.
- **Project context** — `ProjectContext` already carries domain (healthcare / e-commerce / etc.) and persona scaffolding from the API Test Generator. Reuse without translation.
- **SSRF guard** — `server/middleware/urlValidator.js`. The new endpoint reuses it for the target URL. `ALLOW_PRIVATE_SCAN` flag handles internal QA targets.
- **Auth** — Keycloak via `server/middleware/auth.js`. **No new auth surface.** The earlier draft's API-key / OAuth-client problem is deleted from this plan entirely.

## Phased delivery — two phases, one kill-gate

| Phase | What ships | Days | Kill-gate |
|---|---|---|---|
| **0. Code-out + preview** | New page `SmartFormTester.jsx`. Tester enters URL → AAQUA opens it in Playwright server-side → AI maps fields → returns (a) annotated screenshot showing "what I'd type", (b) value list (copy-paste-able), (c) generated Playwright `page.fill()` code block. Persona dropdown, negative/L10n mode toggles. | **2–3** | "Are automation engineers actually saving the code into their suites? Are manual testers using the value list ≥3×/week?" |
| **1. Interactive remote browser** *(only if Phase 0 adoption proves)* | Upgrade to a live, interactive Playwright session: WebSocket screencast, mouse/keyboard input forwarding, "Smart Fill" button that drives the live browser. Recording → exportable Playwright spec. | **+8** | Ship to clients |

**Total: 2–3 days to first useful version**, with Phase 1 deferred until demand is proven.

## Decisions that vanished vs the plugin plan

| # | Old decision | New status |
|---|---|---|
| Auth model | Per-user API keys / OAuth client / token forwarding | **Deleted.** Reuses Keycloak login |
| Distribution | Chrome Web Store + sideload mess | **Deleted.** Lives at an AAQUA URL |
| Target browsers | Chrome + Edge MV3 first | **Deleted.** Playwright supports Chromium / Firefox / WebKit; user picks |
| Framework event quirks | React/Vue/Angular dispatch trick | **Deleted.** Playwright's `fill()` handles all frameworks correctly |
| Iframe & shadow DOM | Same-origin only, Stripe out of scope | **Deleted.** Playwright sees everything |
| Browser-autofill conflict | 1Password / Chrome autofill suppression | **Deleted.** Server-side Playwright has no extensions installed |

Six decisions that ate days in the plugin plan **don't exist** in this one.

## Decisions still to lock

| # | Decision | Recommendation |
|---|---|---|
| 1 | Target-app auth handling | Phase 0: tester pastes credentials into AAQUA with a clear "in-memory only, never persisted" disclaimer. Phase 1: reuse `/api/browser/capture` cookie-import flow as the better path |
| 2 | Session timeout | 10 min idle; tester can extend. Playwright browser closes server-side on timeout |
| 3 | Concurrency cap | Max 5 concurrent sessions per AAQUA instance initially. Queue beyond that with "estimated wait: ~30s" indicator. Tune from observed RAM use |
| 4 | Field detection strategy | Hybrid: heuristic dictionary (`name`, `type`, `aria-label`, `placeholder`) fires first; LLM only for unknowns, with per-URL+field-set-hash cache |
| 5 | Persona model | Reuse API Test Generator persona JSON directly — no translation layer needed when Playwright is doing the typing |
| 6 | Negative-data mode | Six categories: long-string overflow, leading/trailing whitespace, SQL-ish, XSS-ish, unicode confusables, type mismatch. Toggleable in the page UI |
| 7 | L10n mode | Reuse `LocalizationTester` language list |
| 8 | Output layout | Three-pane: annotated screenshot left, value list center, Playwright code block right. Each value labelled with selector + reasoning ("filled because aria-label = 'given name'") |
| 9 | Private targets | Honor existing `ALLOW_PRIVATE_SCAN` env flag for `10.x` / `192.168.x` targets — no new policy |
| 10 | Phase 1 screencast tech | Defer details until Phase 0 adoption proves. Likely candidate: CDP screencast (`Page.startScreencast`) over WebSocket |

## New surface area (Phase 0)

**Backend** (~120 LOC):
- `POST /api/smart-form/analyze` — accepts `{ url, persona?, mode?, locale?, targetAuth? }`. Returns `{ screenshot (base64 PNG), fields: [{ selector, label, suggestedValue, reasoning, type }], playwrightCode (string), warnings: string[] }`. Internally: launch Playwright → goto URL → optional login → DOM-scrape form fields → LLM-map semantics → generate values via Test Data Generator → render annotated screenshot → close browser.
- Reuses `chromium.launch()` pattern from the existing `/api/browser/*` endpoints.

**Frontend** (~200 LOC):
- `src/pages/SmartFormTester.jsx` — URL input, persona dropdown, mode toggles, run button, three-pane result view.
- `src/services/smartFormService.js` — thin wrapper around the new API.
- Sidebar entry + route in `App.jsx`.

**No extension. No new auth surface. No new database tables. No new dependencies.**

## The AI angle — unchanged from the plugin plan, just delivered differently

1. **Semantic field mapping** — LLM identifies `"Subscriber Given Name"` as `firstName` without name/id hints.
2. **Domain-aware data** — healthcare project → synthetic NHS number, valid DOB. E-commerce → realistic SKUs and addresses.
3. **Negative-data mode** — one click, boundary/injection-style fills on the same form.
4. **L10n mode** — fills in Hindi / Tamil / Arabic to surface character-encoding and layout bugs.
5. **Audit trail** — every analyze call logged server-side via the existing Keycloak `req.user.id` (free — no extra plumbing).

## Risks (in severity order)

1. **Adoption — the only big one.** Automation engineers might just copy values manually rather than use AAQUA. Manual testers might find "switch to AAQUA tab → type URL → wait for analysis → copy values back" too slow vs typing 10 fields themselves. Mitigation: Phase 0 specifically measures this. Stop here if metrics miss.
2. **Server-side browser cost.** Each Playwright session ≈ 300 MB RAM. 5 concurrent sessions ≈ 1.5 GB. Acceptable on the current AAQUA server; monitor CPU on demo days.
3. **Target-app auth UX.** Pasting credentials into AAQUA will make security-conscious testers uncomfortable. Mitigation: clear "in-memory only, never persisted" disclaimer + alternative cookie-capture flow available.
4. **Private/VPN targets.** AAQUA's server can't reach `internal.company.local` from a dev's laptop. Same limitation as ZAP scans today — testers already understand it.
5. **"AAQUA's browser ≠ my browser" coverage gap.** A bug that only repros in a specific tester's Chrome profile won't appear in Playwright. Frame this as "Smart Form Tester is for generating test data, not for reproducing browser-specific bugs."
6. **Field-mapping false positives.** LLM occasionally maps wrong (e.g. "Member ID" → first name). Mitigation: show **reasoning** ("filled because aria-label said 'given name'") next to each value, so testers spot bad guesses before copying.

## Success criteria

- **Phase 0 → Phase 1 gate** (measured 2 weeks after launch):
  - ≥3 automation engineers save the generated Playwright code into ≥10 specs total
  - ≥5 manual testers use the value-list output ≥3×/week
  - LLM mapping false-positive rate ≤15% across a manual sample of 30 forms
  - Median analyze-to-result latency ≤4 s (single form, 10–20 fields)
- **Phase 1 ship** (if reached):
  - Live screencast latency ≤200 ms median
  - 5 concurrent sessions sustainable on current AAQUA server for 30 min
  - ≥1 client demo lands using the interactive remote browser

## Open questions for the team

1. Phase 0 demand-validation: which cohort is the right pilot? Internal QA only, or one design-partner client?
2. Target-app credentials: is "paste into AAQUA, in-memory only" acceptable, or do we mandate the cookie-import flow from day 1? (Cookie-import works but is a worse first-time UX.)
3. Output layout: three-pane as described, or a tabbed view (screenshot / values / code)? Lay out both and pick after one design review.
4. Should the analyze call log to Release Readiness as an "exploratory action," or stay invisible from the readiness score?
