# AAQUA — Project Onboarding Playbook

Status: **Reusable template.** Drafted 2026-06-03.

Generic, fork-per-project playbook for implementing AAQUA into a new project (internal team, design-partner client, or external customer). Fork this file to `2026-MM-DD-aaqua-onboarding-<project-slug>.md` and customize.

## Purpose

AAQUA has enough surface area (14+ feature areas) that turning every capability on for every project is a recipe for overwhelm and stalled adoption. This playbook gives a repeatable shape: **discover what the project actually needs → pilot one feature → expand → steady-state**, with explicit exit gates between stages.

## When to use

- A new team / product / client is being onboarded to AAQUA.
- A team that previously used one AAQUA feature wants to expand into others.
- A failed pilot needs a structured second attempt.

**Don't use** for: single-feature ad-hoc requests ("can you run one ZAP scan for me?"). That's a support ticket, not an onboarding.

## Pre-requisites (must exist before discovery)

- AAQUA deployment available (shared-infra tenant, or local-dev `docker-compose.security.yml`).
- Keycloak realm + project lead accounts provisioned.
- Project sponsor identified — someone with authority to approve scope and unblock integrations.
- A nominated **QA champion** inside the project team (see Roles below).

If any of these are missing, fix that first — onboarding without a champion is the #1 failure mode.

---

## Phase A — Discovery (1–2 days)

### Discovery questions

Ask the project team, in order:

**App shape**
- Web SPA, mobile web, native mobile, API-only, mixed?
- Frontend stack: React / Vue / Angular / other?
- Backend stack: Java / Node / Python / .NET / other?
- Public-facing or internal-only? VPN-gated?

**Existing test landscape**
- Existing automated tests: Selenium / Cypress / Playwright / TestNG / pytest / none?
- Existing manual QA team size?
- Existing test management tool: Jira/Xray? Zephyr? TestRail? None?
- CI/CD: GitHub Actions? Jenkins? Azure DevOps?

**Domain**
- Healthcare / fintech / e-commerce / govtech / other? — drives test-data realism + privacy posture
- B2B / B2C? — drives persona modeling
- Languages supported? — drives L10n scope

**Pain points today** (in tester's words, not management's)
- Where do testers spend their day?
- What gets cut when timelines slip?
- What's the most-hated repetitive task?

**Compliance scope**
- WCAG required? (US Section 508, EU EN 301 549, etc.)
- OWASP scan mandated? (PCI-DSS, HIPAA, government)
- Performance budgets / SLAs?
- Data residency restrictions on LLM calls?

### Discovery output

A one-page summary document with answers to the above, signed off by the project sponsor before Phase B starts.

---

## Phase B — Capability mapping (½ day)

Match the discovery answers to AAQUA features. Use this matrix:

| Project need | AAQUA feature | When to prioritize |
|---|---|---|
| Generate functional test cases from user stories / requirements | **Test Generator** + **Test Plan Generator** | Always — Phase 1 default |
| Test data setup is a daily chore | **Test Data Generator** | Always — Phase 1 default |
| Legacy Selenium / TestNG suite needs to keep running | **Test Runner** (Maven/Playwright/Cypress) | Phase 1 if legacy exists |
| Convert legacy Selenium to Playwright/Cypress | **Migration Service** | Phase 1 if migration is in flight |
| Scaffold a new test framework from scratch | **Framework Generator** | Phase 1 if greenfield project |
| API contract testing | **API Test Generator** (OpenAPI/Swagger import) | Phase 1 if API-heavy |
| End-to-end business-process tests | **BPMN flow testing** | Phase 2 if process-orchestrated (Camunda, etc.) |
| Locator brittleness / flaky tests | **Smart Locators** + **Test Runner autoheal** | Phase 2 |
| WCAG audit | **Accessibility Scanner** | Phase 1 if regulated, Phase 2 otherwise |
| OWASP / security scan | **Security Scanner** (ZAP) | Phase 1 if compliance-mandated, Phase 2 otherwise |
| Performance budgets | **Performance Scanner** (Lighthouse + k6) | Phase 1 if SLA-bound, Phase 2 otherwise |
| Multi-language UX testing | **Localization Tester** | Phase 1 if global launch, Phase 2 otherwise |
| Bug tracking | **Jira integration** | Always if Jira exists |
| Go / no-go release decision | **Release Readiness** (5-pillar score) | Always — this is the management dashboard |

### The "Phase 1" rule

Pick **at most 3 features** for Phase 1 (the pilot). More than 3 = adoption stalls.

The first feature should be the one that **(a) solves the tester's most-hated daily task** AND **(b) produces visible output in one session**. Test Generator + Test Data Generator almost always satisfy both.

### Capability map output

A second one-pager: the matrix above with each row marked **Phase 1 / Phase 2 / Skip / Maybe**. Signed off by sponsor.

---

## Phase C — Pilot (2 weeks)

### Goals

- Prove value on **one sub-area** of the project (one module, one feature, one persona).
- Surface integration gotchas (Keycloak roles, Jira project keys, network reachability) early.
- Build the QA champion's confidence so they can advocate internally.

### Activities

| Day | Activity |
|---|---|
| 1 | Project created in AAQUA. Target URL, domain context, Jira key, OpenAPI URL configured |
| 1–2 | First test artifact produced (test cases / scan / generated framework). Reviewed by QA champion |
| 3–5 | Champion uses the feature independently. Document friction. |
| 6–8 | Iterate: prompt tuning, persona refinement, output format adjustment |
| 9 | Mini-demo to project lead. Honest assessment of value |
| 10 | Go/no-go decision for Phase D (Expand) |

### Exit gate

All three must be true:
1. ≥1 tester says "this saved me time" (named, on the record).
2. ≥1 measurable artifact persists in the project (test cases logged, scan stored, defects routed to Jira).
3. ≥1 friction point documented and either fixed or owned by a named person.

If any of these fail → stop. Do not expand a stalled pilot.

---

## Phase D — Expand (4–6 weeks)

### Goals

- Add the next 2–3 features from the Phase 1 list.
- Onboard the rest of the QA team (not just the champion).
- Wire AAQUA into Jira + CI/CD so it becomes part of the project's daily flow, not a side tool.

### Activities

- **Week 1**: Feature #2 enabled. Champion-led 30-min walkthrough for the team.
- **Week 2**: Feature #3 enabled. Jira integration live — every defect found in AAQUA auto-creates a ticket.
- **Week 3**: CI integration — Test Runner runs in CI on PRs, Release Readiness score posted to PR.
- **Week 4**: Half the QA team uses ≥1 AAQUA feature daily.
- **Week 5–6**: Process baked into team rituals (standup mentions, sprint reviews, retros). AAQUA team transitions to consult-only.

### Exit gate

- Daily active usage by ≥50% of the project's QA team for 2 weeks running.
- Release Readiness score generated for ≥1 release cycle.
- Champion confirms team owns the daily cadence (AAQUA team is no longer in the loop).

---

## Phase E — Steady-state (ongoing)

### Cadence

- **Monthly review** (30 min): pillar scores reviewed, feature usage stats reviewed, blockers escalated.
- **Quarterly check** (1 hour): is the project ready to enable the next 2–3 deferred features (Phase 2)?

### Triggers to re-engage

- Release Readiness score drops two months in a row.
- Active user count falls below the Phase D threshold.
- A feature is requested that needs new project configuration.

---

## Per-feature integration checklists

For each feature being turned on, the project lead runs through:

### Generic checklist (applies to all features)

1. **Configure** — feature-specific settings in the AAQUA project record (URL, domain, language list, OpenAPI URL, Jira key, etc.).
2. **Seed** — first run on a known input. Output reviewed by champion.
3. **Verify** — does the output match what a human would produce? Tune prompt parameters if not.
4. **Train** — 30-min walkthrough with the team that will use it daily. Record it.
5. **Integrate** — wire into existing flow (Jira ticket creation, CI test run, dashboard).
6. **Measure** — define ≥1 success metric. Add to the monthly review template.

### Feature-specific gotchas (the things that bite in onboarding)

- **Test Generator**: prompt tuning matters. Run 5 inputs, compare to human-written cases, adjust persona/domain hints.
- **API Test Generator**: OpenAPI spec must be valid and dereffed. Run `swagger-parser` against it first.
- **Test Runner**: the uploaded project's marker file (`pom.xml`, `playwright.config.*`) must be at the root or one folder deep. Migration Service output now scaffolds this correctly.
- **Security Scanner (ZAP)**: needs `ALLOW_PRIVATE_SCAN=true` for `10.x` / `192.168.x` targets. Confirm before pilot day.
- **Accessibility Scanner**: WCAG level (A / AA / AAA) must be configured. Default = AA.
- **Performance Scanner**: Lighthouse runs once per URL; the SLA target (LCP / TBT thresholds) is per-project.
- **Localization Tester**: language list comes from the project config — not auto-detected.
- **Release Readiness**: requires ≥1 result from ≥1 pillar before it shows a score. Plan the pilot so Phase 1 features feed at least one pillar.
- **Jira integration**: requires Jira project key + service account credentials. Set up day 1 of pilot, not day 10.

---

## Roles & responsibilities

| Role | Owner | What they do | Time commitment |
|---|---|---|---|
| Project sponsor | Project lead (their side) | Approves scope, unblocks integrations (Jira keys, network access, Keycloak roles), settles disputes | ~2 hours/week during Phases A–D |
| AAQUA implementation lead | You / your team | Runs discovery, capability mapping, training, integration | Full-time during Phase C; 50% during Phase D |
| QA champion | One nominated tester (their side) | Daily user during pilot. Honest feedback channel. Becomes internal advocate. **The single most important role** | Full-time during Phase C; 25% during Phase D |
| Platform support | AAQUA platform team | Shared-infra capacity, Keycloak realm onboarding, troubleshooting | On-call during Phases A–D |

**Without a QA champion, pilots fail.** No exceptions. If the project can't nominate one, push the onboarding back until they can.

---

## Success metrics

Pick metrics from three levels, in priority order:

### Outcome metrics (what stakeholders care about)

- Defect detection rate change (before AAQUA → after AAQUA)
- Time-to-test-cycle change
- Release Readiness score trend
- Time-to-first-defect-fixed (issue creation → PR merged)

### Usage metrics (proves adoption)

- Active users / week
- Features used / week
- Artifacts generated: test cases, scans run, defects routed

### Quality metrics (proves the AI is actually helpful)

- Generated test case acceptance rate (vs % rewritten by humans)
- False-positive rate on security/accessibility findings
- Migration conversion accuracy (vs % of converted files needing manual fix)

**Pick one outcome metric to be measured on.** Three split focus and kill accountability. Outcome > usage > quality.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| "We already have tools" — perceived overlap with existing test management | Position AAQUA as the AI layer **on top of** existing tools, not a replacement. Integrate with Jira / GitHub / their current CI — don't compete |
| Tester resistance to AI-generated artifacts | Pilot with the champion's most-trusted teammate. Word of mouth beats top-down rollout |
| LLM cost at scale | Project-scoped quotas + caching. Surface cost-per-test-case in the management dashboard |
| Private-network apps unreachable | `ALLOW_PRIVATE_SCAN` flag + on-prem AAQUA option for sensitive deployments |
| Compliance / data residency | Local-dev `docker-compose.security.yml` runs everything on the tester's machine. Cloud LLM call is the only egress. Document this clearly day 1 |
| Champion leaves the project mid-pilot | Nominate a backup champion at Phase C kickoff. Don't proceed without one |
| Capability map promises too much | The "max 3 features for Phase 1" rule exists specifically to prevent this. Hold the line |

---

## Templates

### Discovery doc — one page

```
Project: <name>
Sponsor: <name, role>
QA champion: <name, role, time commitment>
Backup champion: <name>

App shape:
  - Type:
  - Frontend:
  - Backend:
  - Network:
Existing test landscape:
  - Automation:
  - Manual team size:
  - Test mgmt tool:
  - CI/CD:
Domain:
  - Industry:
  - Languages:
  - B2B/B2C:
Pain points (tester voice):
  1.
  2.
  3.
Compliance:
  - WCAG:
  - OWASP:
  - Performance SLA:
  - Data residency:
```

### Capability map — one page

[The capability mapping matrix from Phase B, with each row marked **Phase 1 / Phase 2 / Skip / Maybe**.]

### Status report — weekly during Phase C/D

```
Week N of phase <C|D>:
Active features: ...
Active users this week: ...
Artifacts produced this week: ...
Blockers: ...
Champion's feedback (verbatim): ...
Next week:
```

---

## FAQ

**Q: How long is a "typical" onboarding?**  
A: ~8 weeks from kickoff to steady-state for a single project team. Micro-teams: 4 weeks. Large multi-team programs: stagger, 8 weeks per team.

**Q: Can we skip the pilot if we're confident?**  
A: No. The pilot exists to surface integration gotchas (Keycloak, Jira, network) cheaply. Skipping it means those gotchas surface during full rollout — much more expensive.

**Q: What if the project doesn't have a QA champion to nominate?**  
A: Push the onboarding back. The single highest predictor of pilot success is champion engagement.

**Q: What if the LLM output is bad on this project's domain?**  
A: Tune the persona + domain hints during Phase C. If output is still bad after a week of tuning, that domain may need a custom fine-tuned model — escalate to platform team. Don't ship a bad pilot.

**Q: What about cost?**  
A: Per-call LLM cost is observable today; per-project budget caps are on the platform roadmap. For Phase C pilots, costs are negligible (<$50/week typical). For Phase D and beyond, monitor.

---

## Document conventions

- Fork this file per project: `2026-MM-DD-aaqua-onboarding-<project-slug>.md`.
- Fill in the templates as Phase A / B outputs.
- Track Phase C / D status weekly in the forked doc.
- Archive after Phase E begins.
