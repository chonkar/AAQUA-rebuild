# API-Spec → Automation Scripts + BPMN → Test Cases

Status: **Plan only — not started.** Drafted 2026-05-21.

## Goal

When a user supplies API endpoints (an OpenAPI/Swagger spec) the system generates
automation scripts (REST Assured for Java, or Playwright for JS/TS). When a BPMN
business-process model is supplied (file, URL, or fetched from a BPM engine's API),
the system enumerates the process paths and generates end-to-end test cases — reusing
the API generators for the "service task" steps.

## What already exists (reuse, don't rebuild)

- **LLM**: `LocalLLM` (browser `src/utils/llmClient.js` + server `server/utils/llmClient.js`), `generateWithRetry` with 429 backoff (`server/utils/aiUtils.js`).
- **Scaffolding**: `/api/generate-framework` (`server/index.js`) emits Playwright (TS/JS), Cypress, Selenium (Java/Py/JS) as a streamed ZIP. REST Assured ships today only as an `apiTesting` flag inside Selenium/Java.
- **Migration pattern**: `/api/convert` does file-by-file LLM generation server-side with retry — the model to copy for per-endpoint generation.
- **OpenAPI today**: only *consumed* by ZAP (`runApiScan` → `importOpenApiSpec` in `server/services/zapService.js`); ZAP parses it. No in-repo spec parser, no `swagger-parser` dependency.
- **BPMN today**: zero handling. `fast-xml-parser@5.3.7` is present (used for TestNG reports) and can parse BPMN XML.

## Decisions to lock before coding

| # | Decision | Recommendation |
|---|---|---|
| 1 | Spec input methods | URL + file upload + paste (all three) |
| 2 | OpenAPI parser | `@apidevtools/swagger-parser` (deref + validate). New dep. |
| 3 | Where UI lives | New "API Test Generator" page; calls existing framework-scaffolding service |
| 4 | Script targets | REST Assured (Java/TestNG) + Playwright API (TS `request`), user-selectable |
| 5 | Test depth per endpoint | Configurable: positive, negative(400/422), auth(401/403), schema, boundary. Default = positive+negative+schema |
| 6 | Output | ZIP first; GitHub push later (folds into 2026-05-08 GitHub-runner plan) |
| 7 | BPMN path strategy | Happy + each gateway branch once (basis-path); bound loops to 1 iteration |
| 8 | BPMN task→test mapping | Heuristic: serviceTask→API test, userTask→UI test, scriptTask→API/skip; user override |
| 9 | BPMN source types | file + URL + BPM-engine adapter |
| 10 | Engines first | Camunda 7 first; Flowable/Activiti share a shape; defer Zeebe/Camunda 8 |
| 11 | Use runtime history? | Yes, optional — prioritize paths by real execution frequency; fall back to basis-path |
| 12 | Engine/git credential storage | Shared encrypted per-project store (same as GitHub PAT plan) |
| 13 | Live polling vs one-shot | One-shot fetch + "re-sync" button |

## Feature A — API endpoints → automation scripts

- **A1 Spec ingestion** (`server/services/apiSpecService.js`): `parseSpec(input)` (URL/text/file) via swagger-parser → normalized endpoint catalog `[{operationId, method, path, params, requestBodySchema, responses, security}]`. Reuse `validateOpenApiUrl` SSRF guard.
- **A2 Endpoint → test-case model** (`server/services/apiTestGenService.js`): per endpoint, LLM emits structured cases `{name, category, request, expectedStatus, assertions}`. Batch to respect tokens.
- **A3 Emitters** (template-driven, NOT LLM-emitted whole files): `restAssuredEmitter.js`, `playwrightApiEmitter.js`. LLM only fills assertion bodies. New `POST /api/generate-api-tests` → parse → gen cases → emit → reuse framework scaffolding → stream ZIP.
- **A4 Frontend**: `src/pages/ApiTestGenerator.jsx` + `src/services/apiTestGenService.js`. Inputs: spec source, framework+language, auth, category checkboxes, endpoint multi-select. Register route + Sidebar nav.

## Feature B — BPMN → test cases

- **B0 Source adapter** (`server/services/bpmnSourceService.js`): `fetchBpmn(source)` for `{type:'file'|'url'|'engine'}`. Engine adapters (Camunda7: `GET /engine-rest/process-definition/{id}/xml` → `body.bpmn20Xml`; Flowable/Activiti: `.../resourcedata` raw XML). Returns raw BPMN XML.
- **B1 Parse & graph** (`server/services/bpmnService.js`): `parseBpmn(xml)` via fast-xml-parser → graph of tasks/gateways/events/flows + lanes.
- **B2 Path enumeration**: `enumeratePaths(graph, strategy)` — basis-path (happy + each branch once), loops bounded to 1.
- **B2.5 (optional) History weighting**: pull engine history API (e.g. Camunda `GET /history/activity-instance`), rank paths by real frequency. Aggregate server-side, don't feed raw to LLM.
- **B3 Path → test case**: `pathsToTestCases(paths, graph)` — LLM turns each path into a readable case in the SAME JSON shape as `testCaseGenerationService` (renders in existing TestGenerator table/exports).
- **B4 BPMN → automation**: tag each step by task type; serviceTask → reuse Feature A emitters (API test), userTask → Playwright UI stub. A path becomes one mixed API+UI end-to-end test. UI: `src/pages/BpmnTestGenerator.jsx` or a tab on ApiTestGenerator.

### Clarification captured in conversation
- "BPMN via API" only changes *how the model is delivered* (file vs engine API). The parse→enumerate→generate pipeline is unchanged. You STILL need Feature B because Flow 1 tests endpoints in isolation; Flow 2 tests the end-to-end journey across steps + decisions.

## Incremental ingestion — the "living catalog" (n specs/BPMN over time)

Each upload is a **merge, not a replace**. The project keeps a permanent catalog; new uploads are diffed against it.

**Identity / fingerprints:**
- API endpoint = `METHOD + path` (within a logical *service*).
- BPMN process = `process key` (with versions).

**Catalog hierarchy:**
```
Project
 ├── Service (e.g. "payments-api")
 │     └── Spec version (uploaded date)
 │           └── Endpoints (method+path)
 ├── Process (e.g. "loan-approval")
 │     └── Process version
 │           └── Paths/tasks
 ├── Links (bpmn task ↔ endpoint)
 └── Generated tests (each tied back to its source endpoint or path)
```

**Four-bucket diff on each upload (within a service / process key):**
- 🟢 New (unseen fingerprint) → add, generate tests.
- 🟡 Changed (same fingerprint, different schema/params/responses) → update, mark old tests STALE for regen.
- ⚪ Unchanged → leave it and its tests alone.
- 🔴 Removed (was present, now absent) → flag DEPRECATED for review (no auto-delete).

Show a **preview diff** before committing ("3 new, 2 changed, 1 removed").

**Distinct APIs vs versions:** new *service* coexists (additive); new *version of same service* is diffed. Same for BPMN: new process key = additive; same key = version diff.

**Cross-link payoff:** because a BPMN serviceTask links to an endpoint, a changed/removed endpoint flags the BPMN paths (and their end-to-end tests) that depend on it — and vice versa.

**Test regeneration is surgical:** unchanged → untouched; changed → regenerate only that test; new → add; removed → flag. Keep a record mapping each generated test to its source.

### Remaining decisions (incremental layer)
- Auto-regenerate stale tests, or wait for a user click? (recommend: wait + "regenerate stale" button)
- "Changed" detection: exact schema match vs ignore cosmetic edits (descriptions, examples)?

## Rough effort

```
Feature A: A1 1-2d, A2 2d, A3 3d, A4 2d
Feature B: B0 1d, B1 1d, B2 2d, B3 1-2d, B4 2-3d (task-mapping UI is the hard part)
Incremental catalog layer: ~3-4d (data model + diff + preview UI)
```

## Key risks
- swagger-parser circular `$ref` → use `.bundle()` fallback; cap schema recursion before LLM.
- Never let LLM emit whole code files (hallucinated imports). Templates + LLM-filled assertions only.
- Don't bake secrets into generated ZIPs; emit `.env.example` + auth helper.
- BPMN dialect variance (Camunda/Bizagi/Signavio) — parse standard BPMN 2.0 only in v1.
- Gateway path explosion — enforce basis-path + loop bounding.
- `conditionExpression` is often prose — LLM interprets to assertions; flag low-confidence for review.
- Engine reachability: BPM engines are usually internal — needs the same SSRF allowlist escape hatch as `ALLOW_PRIVATE_SCAN`.
- XML-in-JSON: engine responses escape the BPMN XML; unescape before parsing.
- Process versioning: resolve "latest" by default, allow pinning.

## Related
- 2026-05-08 GitHub-runner + auto-heal plan — generated projects can be pushed to a repo and run through the GitHub runner; shared encrypted credential store.
