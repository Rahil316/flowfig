# flowfig — Project Tracking

Living status document. Update phase status and checkboxes as work actually lands — this file tracks *state*, not design; design detail belongs in `Documentation/architecture-plan.md` (whole-repo) or `packages/*/ARCHITECTURE.md` (per-package) and should not be duplicated here.

Check `Documentation/MISSION.md` before adding scope to any phase below — if it's not traceable to that page, it doesn't belong in v1.

---

## Phase status

| Phase | Package | Focus | Status | Docs |
|---|---|---|---|---|
| P0 | `core` | Resolver + Translator as pure, fixture-tested TS | 🟠 In progress — types + format validation landed (tasks 1-3), resolver/translator/matching logic not yet written | [ARCHITECTURE.md](../packages/core/ARCHITECTURE.md) |
| P1 | `figma-plugin` | Node Writer + scraper | 🟡 Planned — architecture written, blocked on P0 | [ARCHITECTURE.md](../packages/figma-plugin/ARCHITECTURE.md) |
| P2 | `agent-kit` | The flagship CLI, npm-published | 🟡 Planned — architecture written, blocked on P0 + P1 | [ARCHITECTURE.md](../packages/agent-kit/ARCHITECTURE.md) |
| P3 | `extension` | Chrome MV3 capture (scope widened — see Decision #3) | 🟡 Planned — architecture written, blocked on P0 + P1 | [ARCHITECTURE.md](../packages/extension/ARCHITECTURE.md) |
| P4 | *(cross-cutting)* | Design-system parity depth — variant-matching precision, fuzzy-match tuning, structural-match fuzziness, symbol-table sync UX | ⬜ Not started — no architecture doc yet, deliberately deferred | — |
| P5 | *(cross-cutting)* | Fidelity polish — vector/raster, fonts, gradients/shadows/effects | ⬜ Not started — no architecture doc yet, deliberately deferred | — |

Status legend: ⬜ Not started · 🟡 Planned (architecture exists, no code) · 🟠 In progress · 🟢 Shipped · 🔴 Blocked

Nothing has shipped yet. `core` has real types + format validation (see below); `figma-plugin` has a real build scaffold; `agent-kit` and `extension` still exist only as `package.json` stubs plus an `ARCHITECTURE.md`.

---

## ⚠️ Blocking gate: cross-package contract reconciliation

The four package architecture docs were researched and written **in parallel**, before any of `core` existed as code. Each of `figma-plugin`, `extension`, and `agent-kit` therefore had to *guess* the exact shape of two contracts `core` owns, and each guess landed on a genuinely different shape. Every doc already flags this honestly in its own Open Risks section — this entry exists so the reconciliation is a tracked, scheduled task instead of something that only gets rediscovered by accident once two packages fail to compile against each other.

**Do not start real implementation on P1, P2, or P3 against their current sketched contracts without first completing this reconciliation once P0 ships real types.**

1. **DOM snapshot contract** — `core/ARCHITECTURE.md`'s `RawDomSnapshot`/`RawDomSnapshotNode` (fields: `nodeType`, typed `NormalizedComputedStyle` object, `declaredDeclarations`, `boundingBox`, `scrollSize`, `isSvgRoot`/`outerHTML`) does not match `extension/ARCHITECTURE.md`'s `RawDomNode` (`nodeId`, `classList`, `computedStyle: Record<string,string>`, `rect`, `shadow`/`frame` annotations) or `agent-kit/ARCHITECTURE.md`'s `SnapshotNode` (`tag`, `attributes`, `text`, `computedStyle: Record<string,string>`, `box`). All three docs propose this converge once `core` lands — `agent-kit`'s doc goes furthest and proposes the walker be one shared function living in `core`, not three independent implementations of the same contract.
2. **Token-detection side channel is missing from one of the three sketches.** `core`'s design relies on a `declaredDeclarations` side-channel (declared CSS text, not computed output) to detect `var(--ffig-*)` usage — without it, translated files can't reliably survive the cascade per the tagging convention. `agent-kit`'s current `SnapshotNode` sketch has no equivalent field. Confirm agent-kit's driver actually captures this (via Playwright's `document.styleSheets`/`element.style` access, per `core`'s own finding that this channel is available identically in both a content script and a Playwright `page.evaluate()` context) before P2 implementation proceeds.
3. **Symbol table shape** — `core/ARCHITECTURE.md`'s `SymbolTable` (`SymbolComponentEntry.variantProperties`, `SymbolVariableEntry.valuesByMode`/`tokenRef`, `SymbolStyleEntry`) does not match `figma-plugin/ARCHITECTURE.md`'s concrete `.flowfig/symbols.json` (`components[].properties`/`variantOf`, `variables[].modes`/`scopes`/`collection`, `styles[].resolved`). `figma-plugin`'s version is the more concrete, Figma-API-grounded one (it was researched directly against `figma.variables`/component APIs); treat it as the stronger starting point when reconciling, but the reconciliation still needs to happen explicitly rather than by whichever package is implemented first winning by default.

**Owner of resolution**: whoever implements `core`'s `format/types.ts` (P0 task 2, per `core/ARCHITECTURE.md`) should treat this section as required reading before finalizing those types, and should update this section to ✅ once `figma-plugin`, `extension`, and `agent-kit`'s docs are amended to import the real shape instead of their interim vendored copies.

- [x] `core` ships its real `RawDomSnapshot`/`SymbolTable` types (P0 tasks 2 + 4 in `core/ARCHITECTURE.md`) — landed in `packages/core/src/resolver/types.ts` and `packages/core/src/translator/types.ts`. Resolution taken: `RawDomSnapshotNode` kept core's typed `NormalizedComputedStyle` (vs. the other two docs' untyped `Record<string,string>`) since that's what keeps the resolver producer-independent, but gained `shadow`/`frame` opaqueness annotations from `extension`'s draft (core's original sketch had no way to represent a closed-shadow-root/cross-origin-iframe subtree at all — a real gap, not just a naming difference). `SymbolTable` took `figma-plugin`'s stronger fields as designed (`variantOf`, `modes`/`scopes`/`collection`) per the note below.
- [ ] `figma-plugin`'s shared types reconciled against `core`'s real shape (its own task 2) — not started; `core`'s types are ready to import once P1 resumes.
- [ ] `extension`'s vendored `snapshot-types.ts` replaced with a real import + conformance test (its own task 9)
- [ ] `agent-kit`'s RFC (its own task 1) lands and its driver is updated to match, including the `declaredDeclarations`-equivalent gap above

---

## Requirements checklists (condensed — full detail in each package's ARCHITECTURE.md)

### P0 — `core`
- [x] `format`: formatVersion-tagged types for all 3 file kinds + hard-reject validators
- [ ] `resolver`: raw snapshot → resolved tree, including auto-layout/sizing inference — types landed, `resolve()`/`layout.ts`/`sizing.ts`/`text.ts`/`color.ts` not yet written
- [ ] `translator`: resolved tree + tags + symbol table → componentRef/token-annotated tree — types landed, `translate()`/`tags.ts`/`tokens.ts` not yet written
- [ ] `matching`: value-only and structural fuzzy matching, both pure over abstract signatures — types landed, `color.ts`/`spacing.ts`/`structural.ts` not yet written
- [x] Zero `figma`/`chrome`/Node-builtin imports, enforced by lint rule, not convention — `eslint.config.js`'s `packages/core/src/**` block
- [ ] `examples/` fixture set + golden-file tests for resolver and translator

### P1 — `figma-plugin`
- [ ] Import: both `*.capture.flowfig.json` and `*.translated.flowfig.json`
- [ ] Node Writer: key-resolution (3 outcomes) and fuzzy-matching (3 outcomes), two-phase plan/commit
- [ ] Scraper: components/variables/styles → `.flowfig/symbols.json`
- [ ] Write-back: newly-created components register into the live snapshot (F7)
- [ ] `clientStorage`: settings (incl. fuzzy-match-confirmation toggle) + snippets, quota-aware
- [ ] `formatVersion` hard-gate with actionable version-mismatch UX
- [ ] Scaffolded on `@create-figma-plugin`, manifest generated not hand-edited

### P2 — `agent-kit`
- [ ] `flowfig generate`: Playwright render → `core.resolve()` → `core.translate()` → translated file
- [ ] Config loading (`flowfig.config.{ts,js,mjs,json}` / `package.json` key), CLI flags win
- [ ] Reads + validates `.flowfig/symbols.json`, hard-rejects on version mismatch
- [ ] `flowfig doctor`: environment diagnostics with specific, actionable remediation (not generic advice)
- [ ] Font-load failure detection (post-`document.fonts.ready` status check), surfaced not swallowed
- [ ] `docs/AGENT-GUIDE.md` generation from a single source of truth, not hand-duplicated prose
- [ ] Untagged elements still resolve via fuzzy-match fallback (tagging isn't all-or-nothing)

### P3 — `extension`
- [ ] Collector: DOM walk (open shadow roots, same-origin iframes) → computed style + geometry, curated allowlist
- [ ] Hands snapshot to `core.resolve()` — no duplicate resolution logic
- [ ] v1 structural component detection (exact-signature clustering) via `core`'s matching module
- [ ] Preview UI before save; save via `Blob`+`<a download>`, no `"downloads"` permission
- [ ] Minimal manifest: `activeTab` + `scripting` + `storage` only, no standing `host_permissions`
- [ ] Degrades gracefully (opaque placeholder) on closed shadow roots / cross-origin iframes — never crashes

### P4 / P5 — not yet broken down
No architecture doc exists for these phases yet — intentionally deferred per the roadmap (`Documentation/architecture-plan.md`). Do not start detailed planning here until P0–P3 have real, working code; premature P4/P5 design would be planning against an unbuilt foundation.

---

## Decisions log

Full rationale lives in `Documentation/architecture-plan.md`'s **Decisions** section. Recap only, so this file's phase table makes sense without cross-referencing:

1. Snippet storage: `clientStorage` only, no sync service.
2. Fuzzy-match confirmation on exact matches: a user-facing plugin setting (default auto-bind, toggle confirm-all) — not a fixed behavior.
3. Structural component-matching for captured pages: **included in v1** (P3), not deferred — this is why P3's scope is wider than the original architecture-plan draft, and why `extension/ARCHITECTURE.md` designs a real (if intentionally basic) structural-matching module rather than stubbing it.
4. `formatVersion` policy: hard-reject on mismatch, no migration shims — this shows up as a requirement in all four package docs.
5. `figma-plugin` build tooling: `@create-figma-plugin`, not a hand-rolled build.

---

## Consolidated risk register

Pulled from each package's Open Risks section — see the linked doc for full context. Ordered roughly by how likely each is to actually reshape a design once real building starts, not by package.

| Risk | Package(s) | Why it matters |
|---|---|---|
| Shared snapshot contract and symbol-table shape genuinely diverge across docs | `core`, `figma-plugin`, `extension`, `agent-kit` | See the Blocking Gate above — this is the highest-priority open item in the whole project right now. |
| Playwright install fails in network-restricted agent sandboxes (documented, reproducible `EAI_AGAIN` DNS-via-proxy bug) | `agent-kit` | This is `agent-kit`'s actual target audience, not an edge case — `flowfig doctor` and the sandbox guidance table exist specifically because of this finding. |
| `declaredDeclarations` (the token-survives-cascade side channel) is unproven on the extension's side — CORS/Shadow-DOM/CSS-in-JS may silently starve it | `core`, `extension` | If this channel is often empty in practice, token-detection quality on captured pages degrades to fuzzy-matching more often than designed. |
| Figma Community review latency (documented reports of 1–1.5+ month waits) collides with the hard-`formatVersion`-reject policy | `figma-plugin` | A shipped `agent-kit`/`extension` bump can outrun what the installed plugin accepts for weeks — version-mismatch UX is load-bearing, not cosmetic. |
| Closed shadow roots and cross-origin iframes are structurally uncapturable under the extension's minimal-permission model | `extension` | Accepted tradeoff (see Mission's out-of-scope list), but must be surfaced clearly to users, not discovered as a silent gap. |
| CSS Grid flattens to `layoutMode: NONE` (no real prior art found for Grid → auto-layout mapping) | `core` | Possibly too lossy for Grid-heavy generated code (agent-kit's primary input shape); flagged as needing real fixtures before judging. |
| `teamlibrary` permission declared in P1 with no P1 exercise path | `figma-plugin` | Trading a narrower first-review footprint against a guaranteed-cheaper future addition — currently unresolved which nets out cheaper. |
| Font fallback-mapping table has no defined data source | `figma-plugin`, `agent-kit` | `agent-kit` detects a failed font load; `figma-plugin`'s Writer needs a substitute-font table to act on that — the handoff between the two isn't designed yet. |
| Structural-signature symmetry between a DOM subtree and a live Figma component is deferred, not designed | `core`, `figma-plugin` | `core` only defines the DOM-tree side of the signature; the Figma-node-side projector (needed by P1's scraper) doesn't exist yet and may not naturally line up. |

---

## How to use this document

- When a phase's status changes (planning → in progress → shipped), update the **Phase status** table — that's the one line a future conversation should be able to trust at a glance.
- When a requirement checkbox is actually done (code exists, tested, working), check it — not when it's merely designed.
- When a risk in the register gets resolved or a design changes because of it, move it out of the table (or mark it resolved with a one-line note) rather than leaving stale entries to accumulate.
- New phases (P4/P5) get their own `ARCHITECTURE.md` and a checklist section here once P0–P3 are far enough along that planning them isn't premature — see the note under P4/P5 above.
- If new scope shows up that isn't covered by an existing phase, check it against `Documentation/MISSION.md` first. If it doesn't trace back to that page, it's a backlog item to raise explicitly, not something to fold in silently here.

---

*flowfig · project tracking · 2026-07-18*
