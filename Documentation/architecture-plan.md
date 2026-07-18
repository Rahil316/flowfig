# flowfig — Architecture Plan

Two producers, one translation bridge, one writer. Existing pages get **captured** by a Chrome extension. Generated code gets **compiled** by an installable CLI. Both land on the same file format, and only one module — the Figma plugin's Node Writer — is ever allowed to touch `figma.*`.

Same branding family as flowkit — **no functional relationship** — but the same DNA: one repo, several independently-shipped surfaces, a shared core underneath, and a spec that teaches AI agents the local conventions.

---

## Pipeline overview

```
Producer A — existing pages                 Producer B — generated code
─────────────────────────────                ─────────────────────────────
│ Chrome extension           │                │ agent-kit CLI              │
│ real live DOM →            │                │ Playwright-rendered →      │
│ getComputedStyle(),        │                │ real layout engine, no     │
│ getBoundingClientRect()    │                │ browser tab needed         │
──────────────┬──────────────                ──────────────┬──────────────
              │ resolve()                                    │ resolve() + translate()
              ▼                                               ▼
─────────────────────────────                ─────────────────────────────
│ *.capture.flowfig.json     │                │ *.translated.flowfig.json  │
│ resolved, untranslated →   │                │ tagged refs already        │
│ arbitrary CSS, no tag      │                │ resolved to component/     │
│ guarantees                 │                │ token keys                 │
──────────────┬──────────────                ──────────────┬──────────────
              └─────────────────────┬──────────────────────────┘
                                  ▼
              ────────────────────────────────────────
              │ Figma plugin — the only figma.* caller │
              │  • Import   — accepts either file kind │
              │  • Scrape   — components/variables/    │
              │               styles → symbol table    │
              │  • Node Writer — key-resolve or fuzzy-  │
              │               match, then write         │
              ────────────────────────────────────────
                                  │
                                  └─▶ exports .flowfig/symbols.json,
                                    read back by agent-kit for tagging —
                                    the mirror runs in both directions
```

---

## The three file kinds

Everything in this system moves as a file hand-off, never a live connection — consistent end to end, from capture to symbol-table export.

| File | Produced by | Contains | Consumed by |
|---|---|---|---|
| `*.capture.flowfig.json` | extension (`resolve()` only) | Resolved-but-untranslated tree — raw arbitrary CSS | plugin: full translate + fuzzy-match + write |
| `*.translated.flowfig.json` | agent-kit (`resolve()` + `translate()`) | Already-translated node spec, with tagged component/token refs | plugin: key-resolution + write only |
| `.flowfig/symbols.json` | plugin's scraper | Symbol table — components/variables/styles scraped live | agent-kit + the agent itself, read off disk |

---

## Tagging convention

The agent has the symbol table on disk before it generates anything, so it can reference real Figma objects by their stable key — not a name that can drift.

```html
<!-- whole-component reference, resolved by key -->
<div data-flowfig-component="a1b2c3" data-flowfig-props='{"size":"lg"}'>

<!-- explicitly new — writer creates it and writes the key back -->
<div data-flowfig-new-component="CardHeader">

/* token-level reference — survives cascade because the CLI reads
   declared CSS source, not just computed output */
.price { background: var(--ffig-color-accent-500); }
```

Untagged elements and values still work — they just fall back to the same fuzzy-matching parity engine the extension's arbitrary captures rely on. Tagging isn't all-or-nothing per file.

---

## Node Writer — two resolution modes, side by side

- **Key resolution** (tagged) — deterministic. Look up the key live via the Plugin API and bind/instantiate. No ambiguity.
- **Fuzzy matching** (untagged) — exact match binds a Variable/Style; close match surfaces as a suggestion; no match is a per-run user choice (literal value or mint a new token).

Three outcomes when a tagged `componentRef` is hit:

1. **Resolves in the open file** — bind/instantiate. Happy path.
2. **Known key, missing from this file** — surface to the user rather than guess. Also how a stale symbol-table export gets caught — the Writer always re-verifies live, so staleness only ever bites the agent's tags, never the write itself.
3. **Explicitly flagged as new** — Writer creates the component from the translated subtree, registers it in the file, and **writes the fresh key back into the symbol table**. The mirror runs both directions: Figma → code by scrape, code → Figma → code by this write-back.

### Fuzzy-match confirmation is a user setting, not a hardcoded default

Whether an *exact* match auto-binds silently or still surfaces for confirmation is a plugin setting, not fixed behavior:

- **Default: auto-bind exact matches silently.** An exact match to a Variable/Style has no ambiguity — it gets the same no-friction treatment as tagged key-resolution. The confirmation list is reserved for close-but-not-exact matches, where there's a genuine judgment call.
- **Toggle: confirm everything.** Users who want to review every binding before it's written — including exact matches — can flip this on. Slower per-import, but nothing lands without explicit sign-off.

This setting lives in plugin `clientStorage` alongside snippet storage (below).

---

## Snippet storage

Snippets (captured or generated) are stored in the Figma plugin's `clientStorage` only — no sync service, no account system. A snippet made on one machine is not insertable from another machine. This matches the rest of the system's file-hand-off philosophy: nothing here depends on a hosted backend, and it keeps the plugin's only state surface local and simple. Revisit if cross-machine reuse becomes a real user request — it would need a hosted service and auth that no other part of this architecture currently needs.

---

## Publish matrix

Four workspace packages. Only one of them ever runs `npm publish` — the other three ship somewhere else entirely, or nowhere.

| Package | Ships via | Notes |
|---|---|---|
| `agent-kit` | **npm** | The flagship, installable CLI. Any project can add it and generate Figma files straight from its own code. |
| `figma-plugin` | Figma Community | Reviewed and distributed by Figma, not npm. Importer, scraper, Node Writer. Built on `@create-figma-plugin` (see Decisions). |
| `extension` | Chrome Web Store | Reviewed and distributed by Google, not npm. Live-page capture only. |
| `core` | *private* | Never published, never leaves the monorepo. Exists only for clean cross-bundler imports. |

---

## Repo layout

```
flowfig/
├── package.json            # npm workspaces: "packages/*"
├── tsconfig.base.json
├── packages/
│   ├── core/                # private — resolver, translator, design-system matching
│   ├── figma-plugin/         # manifest.json (Figma's) + main/ui + scraper + Node Writer
│   ├── extension/            # manifest.json (Chrome MV3) + content script + popup
│   └── agent-kit/            # the one npm-published package — CLI + tagging + agent guide
├── examples/                 # shared fixtures — keeps the two adapters honest against one contract
├── docs/                     # ships to consumers — incl. agent-kit's generated AGENT-GUIDE.md
└── Documentation/            # dev-only — architecture rationale, decisions log
```

---

## CSS resolution — why the two producers differ

The extension never needs a cascade engine of its own — it's already running inside a real, rendered tab, so `getComputedStyle()`/`getBoundingClientRect()` give it ground truth for free. It only needs `core/resolver`'s normalization step and `core/format`; it never even bundles `core/translator`, since capture files are translated later, inside the plugin.

agent-kit has no browser at all, so it depends on a real one: **Playwright, as a hard dependency from day one** — chosen over a lighter static-parse-first fallback chain for simplicity, and because it's genuinely more capable (true layout for non-auto-layout content and intrinsic sizing that static CSS parsing or jsdom alone can't produce — jsdom resolves cascade but has no layout engine at all).

---

## MVP roadmap

| Phase | Focus | Notes |
|---|---|---|
| P0 | Core engine skeleton | Resolver + Translator as pure, fixture-tested TS packages — no browser or Figma runtime needed to validate the schema. |
| P1 | Figma plugin — writer + scraper | Node Writer proven against hand-built fixture files; scraper exports the first real symbol table. Scaffolded on `@create-figma-plugin`. Nothing downstream is useful without this existing first. |
| P2 | agent-kit CLI — the flagship | Playwright resolve+translate, tagging convention, published to npm. This is the product most users actually install. |
| P3 | Chrome extension | Secondary capture producer, for arbitrary existing pages rather than agent-generated ones. **Scope now includes basic heuristic structural component-matching**, not just value-level token parity (see Decisions — this widens P3 relative to the original cut). |
| P4 | Design-system parity depth | Variant-matching precision, fuzzy-match tuning, symbol-table sync UX. Builds on P3's baseline structural matching rather than introducing it. |
| P5 | Fidelity polish | Vector-vs-raster handling, font fallback tables, gradients/shadows — effects. Multi-viewport/interactive-state capture is a deliberate boundary, not a queued phase. |

---

## Foreseeable issues — already designed around

1. **Schema/version skew.** agent-kit publishes to npm instantly; figma-plugin goes through Figma Community's review, which can lag days. Every file carries an explicit `formatVersion`; the plugin **hard-rejects** a mismatch outright rather than attempting best-effort migration (see Decisions) — fails loudly and specifically rather than misparsing.
2. **Fonts, twice over.** `figma.loadFontAsync` only works with fonts the file actually has — needs a fallback-mapping table. Separately, Playwright needs the same webfont to lay out text correctly in the first place, which can fail quietly in a network-restricted agent sandbox.
3. **Playwright's footprint in agent sandboxes.** Install/launch friction is a real setup step for agent-kit's actual audience (CI-like, constrained environments) — documented explicitly in the agent guide, not assumed to "just work."
4. **Vector vs. raster.** Inline `<svg>` → editable Figma vector node; `<img>`/background photographs → image fill. An explicit detection rule, not an accident of whatever's easiest.
5. **Scope boundary.** One fixed viewport, one DOM state, per generation. Hover/focus/transitions/breakpoints are out of scope for v1 — stated up front, not discovered later.

---

## Decisions

1. **Snippet storage:** plugin-local `clientStorage` only. No sync service. See Snippet storage section above.
2. **Fuzzy-match confirmation:** a user-facing plugin setting, not a fixed default. Ships defaulted to auto-bind-on-exact-match, with a toggle for confirm-everything. See Node Writer section above.
3. **Component-level detection for arbitrary captured pages:** included in v1 (P3), not deferred. The Chrome extension ships with basic heuristic structural component-matching alongside value-level token parity. This widens P3's scope versus the original value-only cut, and P4 now builds on that baseline rather than introducing structural matching itself.
4. **Format-version policy:** hard-reject a `formatVersion` mismatch outright. No best-effort backward migration. Simpler, safer, and consistent with "fails loudly and specifically" in Foreseeable Issues.
5. **Plugin build tooling:** adopt `@create-figma-plugin` for the `figma-plugin` package rather than a hand-rolled build. Saves setup time for P1 and is the widely-used convention for Figma plugin tooling.

---

*flowfig · architecture plan · updated 2026-07-18 · decisions resolved, repo scaffolding starting*
