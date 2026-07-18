# `@flowfig/figma-plugin` — Architecture

*Package: `packages/figma-plugin` · Phase: P1 · Status: pre-implementation planning*

This document is the implementation plan for the Figma plugin package. It assumes
familiarity with `/workspaces/flowfig/Documentation/architecture-plan.md` (the
whole-repo architecture plan) and restates only what's needed to make this
package's decisions self-contained.

---

## Purpose & Scope

`figma-plugin` is the **only module in the flowfig monorepo permitted to call
`figma.*`**. Every other package produces a file; this package is what reads
those files and turns them into real nodes, and what reads the live file back
into a symbol table other packages consume off disk. It has three
responsibilities:

1. **Import** — accept `*.capture.flowfig.json` (untranslated, needs
   translate + fuzzy-match) or `*.translated.flowfig.json` (already tagged,
   needs key-resolution only) and write real nodes.
2. **Scrape** — walk the open file's components, variables, and styles and
   export `.flowfig/symbols.json`, consumed by `agent-kit` and the agent
   itself.
3. **Node Writer** — the actual node-creation/binding logic, in two
   resolution modes (key resolution for tagged refs, fuzzy matching for
   untagged values).

It ships via **Figma Community**, not npm — this is the one workspace package
that does not go through `npm publish` (see publish matrix in the root
architecture plan).

**In scope for this package:** reading `.flowfig.json` files supplied by the
user, calling into `@flowfig/core`'s translate/match functions, all
`figma.*` node-writing and scraping code, the plugin UI (import flow, symbol
table status, settings, snippet library), `clientStorage` persistence.

**Explicitly out of scope:** any resolution/translation/fuzzy-matching
*logic* (that's `@flowfig/core`'s job — this package calls it, never
reimplements it), DOM capture (the extension's job), code generation
(`agent-kit`'s job), any hosted backend or sync service (there is none —
see Decisions #1 in the root plan).

---

## Requirements

### Functional

- **F1.** Import a `*.capture.flowfig.json` file: run `@flowfig/core`'s
  `translate()` against the current file's live symbol table, then run the
  Node Writer.
- **F2.** Import a `*.translated.flowfig.json` file: skip translation, run
  the Node Writer directly against its already-tagged refs.
- **F3.** Reject any input file whose `formatVersion` doesn't match the
  version this plugin build supports, with a specific, actionable error —
  never attempt best-effort parsing of a mismatched version.
- **F4.** Node Writer must resolve tagged `componentRef`s against the live
  Plugin API (never against a possibly-stale symbol-table snapshot) and
  produce exactly one of three outcomes per ref: resolved-and-written,
  known-key-missing-from-file (surfaced, not guessed), or
  explicitly-new (component created, registered, key written back).
- **F5.** Node Writer must fuzzy-match untagged values/nodes against
  `@flowfig/core`'s matching module and produce exactly one of three
  outcomes per value: exact-match (auto-bind or confirm, per user setting),
  close-match (always surfaced as a suggestion), no-match (per-run user
  choice: literal value or mint new token).
- **F6.** Scraper walks the current file's local components, component sets,
  local variables/variable collections, and local styles, and writes
  `.flowfig/symbols.json` to disk in the project the user is working
  against.
- **F7.** Newly-created components (from F4's third outcome) are written
  back into the same symbol table shape the scraper produces, so the next
  scrape (or an in-memory patch, see Scraper section) is consistent.
- **F8.** A user-facing setting controls whether exact fuzzy-matches
  auto-bind silently or require confirmation; persisted in `clientStorage`.
- **F9.** Snippets (captured or generated fragments a user wants to
  re-insert) are stored and retrieved from `clientStorage`, scoped to the
  local machine only.
- **F10.** Import UX must present a diffable summary before committing
  writes to the canvas — outcomes 2 and 3 of key-resolution and all three
  outcomes of fuzzy-matching are review points, not silent side effects,
  except where the auto-bind setting explicitly opts out of review.

### Non-functional

- **N1. No reimplementation of core logic.** Translation, key/value
  resolution algorithms, and fuzzy-matching heuristics live in
  `@flowfig/core`; this package only orchestrates calls into it plus the
  `figma.*` side effects. If a core API is missing something this package
  needs, the fix is to extend core's exposed surface, not to duplicate logic
  here.
- **N2. No network dependency for the core workflow.** Import, scrape, and
  write must all work fully offline — file I/O happens through the UI
  iframe's `<input type="file">` / `download`, not through `fetch`. This
  keeps the manifest's `networkAccess` at `["none"]`, which is also the
  fastest path through Figma Community review (no reviewer scrutiny of what
  a domain allowlist is for).
- **N3. Respect `clientStorage`'s 5 MB/plugin quota.** Settings + snippets
  must fit comfortably inside this; large snippets need a size-aware
  eviction/warning policy rather than a silent quota-exceeded failure.
- **N4. formatVersion is a hard gate.** Version-mismatch handling is a
  first-line check on every import, before any parsing of file content
  beyond reading the version field.
- **N5. Live re-verification, not trust-the-cache.** Every key resolution
  hits the Plugin API live at write time; `.flowfig/symbols.json` is a
  read-side convenience for the agent/CLI, never a write-side source of
  truth inside the plugin.
- **N6. Review-latency resilience.** Because Figma Community review can lag
  days-to-weeks (see Research Findings), the plugin's accepted schema
  version(s) and its UI copy for version mismatches must be designed so an
  end user hitting a skew gets a clear "update pending review" message, not
  a stack trace.
- **N7. Scaffold conformance.** Project structure, build commands, and
  manifest generation must follow `@create-figma-plugin` conventions
  exactly (manifest is generated, never hand-edited) so the package stays
  upgradable with the toolchain rather than diverging into a custom build.

---

## Research Findings

### 1. `@create-figma-plugin` conventions

Source: `yuanqing/create-figma-plugin` on GitHub, its docs site
(yuanqing.github.io/create-figma-plugin — Quick start & Configuration
pages).

- It is the de facto standard toolkit (widely used, actively maintained)
  for Figma/FigJam plugin and widget development. It generates a working
  project (manifest, TS source, esbuild config, `package.json`) rather than
  being a hand-rolled bundler config.
- **`manifest.json` is a build artifact, not a source file.** Configuration
  lives under a `"figma-plugin"` key in `package.json`; the CLI regenerates
  `manifest.json` on every build. Hand-editing `manifest.json` is explicitly
  a mistake the docs warn against — it gets clobbered. This constrains our
  design: any manifest-level setting (network access, permissions, editor
  type, menu commands) must be expressed in `package.json`, never touched
  directly.
- Minimal example config:
  ```json
  {
    "figma-plugin": {
      "editorType": ["figma"],
      "name": "flowfig",
      "main": "src/main.ts",
      "ui": "src/ui.tsx"
    }
  }
  ```
- **Build tool is esbuild**, via the `build-figma-plugin` CLI, invoked as
  npm scripts: `build-figma-plugin --typecheck --minify` (build) and
  `build-figma-plugin --typecheck --watch` (dev). Sub-second builds. TS/JSX
  supported out of the box.
- **UI toolkit is Preact**, not React — `@create-figma-plugin/ui` ships a
  library of Preact components that visually replicate Figma's own editor
  UI (buttons, inputs, dropdowns, etc. that look native). The build CLI
  auto-aliases `react`/`react-dom` imports to `preact/compat`, so if a
  dependency expects React it mostly "just works," but our own UI code
  should be written directly in Preact/JSX against `@create-figma-plugin/ui`
  rather than pulling in real React.
- **CSS Modules** are supported out of the box with hashed class names.
- **Config surface relevant to us**, all under the `figma-plugin` key:
  `main`, `ui`, `editorType` (`"figma" | "figjam" | "dev" | "slides" |
  "buzz"`), `networkAccess` (`allowedDomains`, `reasoning`,
  `devAllowedDomains`), `permissions` (`activeusers`, `currentuser`,
  `fileusers`, `payments`, `teamlibrary`), `capabilities` (`codegen`,
  `inspect`, `textreview`, `vscode`), `menu` (sub-menu commands, each with
  its own `main`/`ui`), `relaunchButtons`.
- **Multiple commands = multiple mains.** The `menu` array lets one plugin
  bundle several distinct entry points (each with its own `main`/`ui`) shown
  as a sub-menu — this is how we'll split Import / Scrape / Settings into
  separate invokable commands sharing one codebase (see Proposed
  Architecture).
- No documentation surfaced on bundling monorepo-sibling packages
  specifically, but esbuild resolves `node_modules` (including npm/yarn
  workspace symlinks) by default — since `@flowfig/core` is a workspace
  package, esbuild will bundle it into both the `main` and `ui` output
  exactly like any other dependency, so long as `@flowfig/core` builds to
  plain JS/TS that esbuild can parse (no bundler-specific syntax). This
  confirms the "consume core as a normal dependency" plan needs no special
  tooling — just a workspace `"@flowfig/core": "*"` (or `workspace:*`)
  dependency.

### 2. Figma Plugin API constraints

- **`clientStorage`** (developers.figma.com/docs/plugins/api/figma-clientStorage):
  `getAsync`, `setAsync`, `deleteAsync`, `keysAsync`. Values may be objects,
  arrays, strings, numbers, booleans, `null`/`undefined`, or `Uint8Array`.
  **Hard quota: 5 MB total per plugin ID.** Quota is computed as key size +
  JSON-serialized value size (raw byte size for `Uint8Array`). Storage is
  scoped per plugin ID *and* per local user/machine — never synced, never
  shared across users, and can be cleared by the user clearing app storage.
  This directly confirms and bounds the snippet-storage decision: it's
  genuinely local-only, and we must budget the 5 MB across settings +
  snippets + any cached state, with snippets as the dominant consumer.
- **`networkAccess` manifest field**: `allowedDomains` is required
  once `networkAccess` is present; `["none"]` disables network entirely;
  `"*"` requires a `reasoning` string justifying it to reviewers. Since
  Import/Scrape/Write are pure file+API operations with no external
  service, we declare `["none"]` — this is also a review-friendlier
  posture (fewer things for a Figma reviewer to question).
- **File I/O is UI-iframe-only.** The main plugin thread (`figma.*` context)
  has no filesystem or `fetch` access of its own; the *UI* (an iframe
  running normal HTML/JS) is what can present `<input type="file">`, read
  it via `FileReader`, and hand the parsed bytes/JSON to the main thread via
  `parent.postMessage({ pluginMessage: ... }, '*')`. The main thread
  receives it via `figma.ui.onmessage`. Same pattern in reverse for
  export: main thread computes `.flowfig/symbols.json`'s content, posts it
  to the UI, and the UI triggers a browser download (there is no direct
  "write to disk" call from the main thread). This is a hard architectural
  constraint, not a stylistic choice — it fixes where file-parsing code
  must live (UI-side, or at least UI-received) versus where `figma.*`
  calls must live (main-thread-only).
- **`figma.variables`**: local variable collections/variables are created
  and mutated with no special permission
  (`createVariableCollection`, `createVariable`, `setValueForMode`,
  `setBoundVariable`/`setBoundVariableForPaint`/`...ForEffect`/`...ForLayoutGrid`).
  Reaching into a **team library** variable (as opposed to one local to the
  open file) requires `importVariableByKeyAsync`, which needs the
  `teamlibrary` permission declared in the manifest and only succeeds
  against *published* variables. Confirms the fuzzy-match "mint new token"
  path is always a local-collection write with zero extra permission,
  while resolving a tagged key that happens to live in a team library
  needs the `teamlibrary` permission from day one (declare it even if P1's
  fixture files never hit that path, so P1's manifest already matches
  what P2/P3 real usage will need — cheaper to declare now than resubmit
  for review later purely to add a permission).
- **`figma.createComponentFromNode` / `figma.createComponent`**: creating a
  component from an already-built node tree (our "explicitly new" outcome)
  uses `createComponentFromNode`, which has real restrictions — the source
  node cannot already be a component/component set and cannot be nested
  inside one. `createComponent()` makes an empty 100×100 component instead
  — not useful for our "promote this subtree" flow. This confirms the
  Writer's new-component path must build the full node tree as a plain
  frame first, *then* call `createComponentFromNode` on the finished tree,
  never the other way around.
- **`figma.loadFontAsync`**: required before setting any text-affecting
  property; only works for fonts already installed (OS-installed, shared
  org fonts, or Google Fonts available to the user's Figma), discoverable
  via `figma.listAvailableFontsAsync()`. Results are cached, so calling it
  liberally is fine perf-wise. There is **no built-in fallback
  mechanism** — if a translated file specifies a font the current file/user
  doesn't have, the load rejects and the Writer must catch this and fall
  back to a mapped substitute font (this is the "fonts, twice over" risk
  called out in the root plan's Foreseeable Issues — the plugin side of
  that risk lands squarely in the Writer's text-node code path).
- **Component key resolution**: `component.key` / `style.key` are readable
  live off any local component/style while the plugin runs.
  `figma.importComponentByKeyAsync(key)` resolves a *published* team
  library component (rejects if unpublished or unreachable) —
  distinct from `figma.getNodeByIdAsync`/`find*` for components local to
  the currently open file. This maps directly onto Node Writer outcome 2
  ("known key but missing from this file"): the Writer must try local
  lookup first, then library import, and only surface the
  missing-from-file error if *both* fail.

### 3. Prior art — Tokens Studio for Figma

Source: Tokens Studio docs (docs.tokens.studio) and its Community listing.

- Tokens Studio keeps token definitions as W3C-adjacent JSON, supports
  multi-file "token sets," and syncs that JSON against GitHub/GitLab as well
  as against Figma's own Variables/Styles — i.e. it treats JSON as the
  portable interchange format and Figma Variables/Styles as one of several
  *export targets*, which is architecturally the same shape flowfig uses
  (JSON file ↔ plugin ↔ live Figma objects).
  Their docs explicitly warn about **Figma's per-entry `setSharedPluginData`
  cap (100 KB per namespace/key/value triple)** as of a 2025 enforcement
  change, separate from the 5 MB `clientStorage` quota — relevant if we
  ever consider stashing anything in shared plugin data (e.g. per-node
  provenance) rather than clientStorage; for now we avoid shared plugin
  data entirely and keep everything in clientStorage or the exported JSON
  file, sidestepping that smaller cap.
  Their "JSON View" lets users hand-edit the token JSON directly inside the
  plugin UI and reapply it — a useful precedent for our own symbol-table
  viewer/diff UI (show the JSON, not just a form).

### 4. Figma Community review process

Source: Figma Help Center ("Plugin and widget review guidelines") and
multiple Figma forum threads from 2025–2026.

- Figma's own stated target is roughly **5–10 business days**, but multiple
  concurrent forum threads report real submissions stuck **1 to 1.5+
  months** during high-volume periods. This is not a one-off complaint —
  it's a recurring, unresolved pattern, which validates treating review
  latency as a designed-around risk rather than an edge case.
- Documented rejection reasons: crashes/obvious bugs, descriptions that
  don't match actual behavior, performance problems (e.g. long-running
  background work), general usability concerns, and content-policy
  violations. None of these are exotic — they're reasons a normal QA pass
  should already catch, which argues for a pre-submission checklist (see
  Phase Task Breakdown) rather than hoping review catches issues for us.
- Practical implication for this design: **every update to the file
  schema this plugin accepts is a shipped-late update by construction.**
  Combined with the hard `formatVersion` rejection policy (Decision #4 in
  the root plan), this means agent-kit (npm, ships instantly) will
  regularly be ahead of what the installed plugin accepts. The plugin's
  version-mismatch error message is therefore not a generic error path —
  it is a first-class piece of UX that needs to explicitly say "this file
  was made with a newer flowfig format than this plugin supports; check
  Figma Community for a pending update" rather than a bare parse failure.

---

## Proposed Architecture

### Package layout

```
packages/figma-plugin/
├── package.json                 # figma-plugin config lives here (see below)
├── tsconfig.json                # extends ../../tsconfig.base.json
├── manifest.json                # GENERATED by build-figma-plugin — never hand-edit
├── ARCHITECTURE.md               # this file
├── src/
│   ├── main/                    # main-thread code — the only code allowed figma.*
│   │   ├── import.main.ts       # entry: Import command
│   │   ├── scrape.main.ts       # entry: Scrape command
│   │   ├── settings.main.ts     # entry: Settings command (thin — mostly UI-driven)
│   │   ├── writer/              # Node Writer — the figma.* write logic
│   │   │   ├── index.ts         # dispatch: writeTree(translatedTree, symbolTable, settings)
│   │   │   ├── key-resolution.ts   # tagged componentRef / variableRef handling
│   │   │   ├── fuzzy-resolution.ts # untagged value handling — calls core's matcher
│   │   │   ├── component-writer.ts # frame-build + createComponentFromNode + key write-back
│   │   │   ├── variable-writer.ts  # createVariable/collection + bind helpers
│   │   │   ├── text-writer.ts      # loadFontAsync + fallback-table handling
│   │   │   └── node-builders.ts    # shape → FrameNode/TextNode/etc, layout props
│   │   ├── scraper/
│   │   │   ├── index.ts         # walk components/variables/styles → SymbolTable
│   │   │   ├── components.ts
│   │   │   ├── variables.ts
│   │   │   └── styles.ts
│   │   ├── storage/
│   │   │   └── client-storage.ts   # typed wrapper over figma.clientStorage
│   │   └── messaging.ts         # typed postMessage envelope (see Message Passing)
│   ├── ui/                      # UI-iframe code — no figma.* access, DOM/Preact only
│   │   ├── import.ui.tsx        # entry: file picker, translate/write preview, outcome review
│   │   ├── scrape.ui.tsx        # entry: scrape trigger + symbols.json download + diff view
│   │   ├── settings.ui.tsx      # entry: fuzzy-match toggle, snippet library manager
│   │   ├── components/          # shared Preact components (built on @create-figma-plugin/ui)
│   │   │   ├── OutcomeList.tsx      # renders the 3 key-resolution / 3 fuzzy outcomes
│   │   │   ├── FilePicker.tsx       # <input type=file>, drag-drop, FileReader → postMessage
│   │   │   └── SnippetLibrary.tsx
│   │   └── messaging.ts         # UI-side half of the typed postMessage envelope
│   └── shared/
│       ├── types.ts             # UiToMain / MainToUi message unions, resolution outcome types
│       └── format-version.ts    # supported formatVersion constant + mismatch error copy
├── fixtures/                     # hand-built *.capture / *.translated fixture files for P1
└── test/
    ├── writer/                  # Node Writer unit tests against fixtures (mocked figma global)
    └── scraper/
```

### Why this split

- **Main vs UI is not a style choice, it's the only place file I/O and
  `figma.*` can each happen** (Research Findings §2). `src/main/**` is the
  only tree allowed to reference the `figma` global; `src/ui/**` is the
  only tree allowed to touch the DOM (`<input type=file>`, `FileReader`,
  triggering downloads). `src/shared/**` is plain data types with zero
  environment dependency, importable from both sides.
- **Three separate commands** (Import / Scrape / Settings), each with its
  own `main`/`ui` entry pair, registered via the `menu` array in
  `package.json`'s `figma-plugin` config. This matches
  `@create-figma-plugin`'s documented multi-command pattern and keeps each
  command's bundle focused — a user invoking "flowfig: Import" doesn't pay
  for scraper code in that bundle and vice versa. Settings is its own
  command mainly to have a clean menu entry; its main-thread footprint is
  tiny (just clientStorage reads/writes proxied for the UI).
- **`writer/` is deliberately not a single god-file.** `key-resolution.ts`
  and `fuzzy-resolution.ts` are the two dispatch paths described in the
  root plan; `component-writer.ts`/`variable-writer.ts`/`text-writer.ts`
  are grouped by the Figma API surface they call (components, variables,
  text/fonts) since each has distinct constraints (creation restrictions,
  permission requirements, font-load fallback) worth isolating for
  testability.

### `package.json` (`figma-plugin` config sketch)

```json
{
  "name": "@flowfig/figma-plugin",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "build-figma-plugin --typecheck --minify",
    "watch": "build-figma-plugin --typecheck --watch",
    "test": "vitest run"
  },
  "figma-plugin": {
    "editorType": ["figma"],
    "name": "flowfig",
    "networkAccess": {
      "allowedDomains": ["none"]
    },
    "permissions": ["teamlibrary"],
    "menu": [
      { "name": "Import…", "main": "src/main/import.main.ts", "ui": "src/ui/import.ui.tsx" },
      { "name": "Scrape symbol table", "main": "src/main/scrape.main.ts", "ui": "src/ui/scrape.ui.tsx" },
      { "name": "Settings", "main": "src/main/settings.main.ts", "ui": "src/ui/settings.ui.tsx" }
    ]
  },
  "dependencies": {
    "@create-figma-plugin/ui": "^4",
    "@flowfig/core": "*",
    "preact": "^10"
  },
  "devDependencies": {
    "@create-figma-plugin/build": "^4",
    "@create-figma-plugin/tsconfig": "^4",
    "@figma/plugin-typings": "^1"
  }
}
```

`teamlibrary` is declared from P1 even though P1's fixture-driven tests may
never exercise a real published library, per Research Findings §2 (cheaper
to declare once than resubmit for review later).

### Message-passing shape (main ⇄ UI)

Defined once in `src/shared/types.ts`, imported by both sides so the
contract can't drift:

```ts
// src/shared/types.ts
type UiToMainMessage =
  | { type: 'import-file'; kind: 'capture' | 'translated'; fileContents: string }
  | { type: 'confirm-outcomes'; decisions: OutcomeDecision[] }
  | { type: 'request-scrape' }
  | { type: 'get-settings' }
  | { type: 'set-settings'; settings: PluginSettings }
  | { type: 'get-snippets' }
  | { type: 'save-snippet'; snippet: Snippet }
  | { type: 'delete-snippet'; id: string }

type MainToUiMessage =
  | { type: 'version-rejected'; fileVersion: string; supportedVersion: string }
  | { type: 'outcomes-ready'; outcomes: ResolutionOutcome[] } // pre-write preview
  | { type: 'write-complete'; summary: WriteSummary }
  | { type: 'write-error'; message: string }
  | { type: 'scrape-complete'; symbolTable: SymbolTable } // UI triggers the download
  | { type: 'settings'; settings: PluginSettings }
  | { type: 'snippets'; snippets: Snippet[] }

interface ResolutionOutcome {
  kind: 'key-resolved' | 'key-missing' | 'key-new'
       | 'fuzzy-exact' | 'fuzzy-close' | 'fuzzy-none'
  ref: string                 // component/variable key, or a path into the tree
  detail: string               // human-readable description for the review list
  requiresConfirmation: boolean
}
```

`ResolutionOutcome.kind` maps 1:1 onto the six outcomes named in the root
plan (three key-resolution, three fuzzy-matching) — this is the seam
between "what core/the Writer decided" and "what the UI shows for review."

### Node Writer internals

```ts
// src/main/writer/index.ts
async function writeTree(
  tree: TranslatedNodeTree,        // from @flowfig/core's format types
  symbolTable: LiveSymbolSnapshot, // built at write-time, not read from disk (N5)
  settings: PluginSettings
): Promise<WriteResult> {
  const outcomes: ResolutionOutcome[] = []
  const plan = planWrite(tree)     // flattens tree into an ordered list of write ops

  for (const node of plan) {
    if (node.ref?.kind === 'component' || node.ref?.kind === 'token') {
      // TAGGED — deterministic key resolution
      outcomes.push(await resolveByKey(node, symbolTable))
    } else if (node.ref?.kind === 'new-component') {
      outcomes.push(await resolveAsNew(node))
    } else {
      // UNTAGGED — delegate the actual match decision to @flowfig/core
      const match = core.matching.match(node.value, symbolTable)
      outcomes.push(dispatchFuzzy(match, settings.fuzzyMatch))
    }
  }

  return { outcomes, /* nodes only committed after UI confirmation, see below */ }
}
```

Two-phase commit, matching Requirement F10: `writeTree` in "plan mode"
resolves *what* would happen and returns `outcomes` without mutating the
canvas (safe to call repeatedly, safe to show as a preview). A second pass,
`commitWrite(outcomes, decisions)`, performs the actual `figma.*` mutations
only for outcomes the user (or the auto-bind setting) approved. This keeps
the Writer itself free of UI concerns — it returns data, the UI decides
what needs confirmation — while still letting the auto-bind-exact-match
setting skip the round-trip for the outcomes it's allowed to.

- **`key-resolution.ts`** implements `resolveByKey`: try
  `figma.getNodeByIdAsync`/local `find*` first (current file), then
  `figma.importComponentByKeyAsync` / `figma.variables.importVariableByKeyAsync`
  (team library) as a fallback, and only emits `key-missing` if both fail —
  directly encoding the Research Findings §2 note on the two lookup paths.
- **`fuzzy-resolution.ts`** calls `@flowfig/core`'s matching module and only
  translates its result into an `outcome.kind` + whether it needs
  confirmation, based on `settings.fuzzyMatch` (`'auto-bind-exact' |
  'confirm-all'`). It performs no matching heuristics of its own (N1).
- **`component-writer.ts`** builds the full node tree as a plain frame via
  `node-builders.ts`, then calls `figma.createComponentFromNode` only once
  the subtree is fully built (Research Findings §2 restriction), registers
  the resulting key, and returns it so `writer/index.ts` can attach it to
  the in-memory `LiveSymbolSnapshot` and queue a symbol-table write-back
  (F7).
- **`text-writer.ts`** wraps every text mutation in `loadFontAsync`, with a
  fallback-mapping table (config, not hardcoded) consulted on rejection —
  this is the plugin-side half of the "fonts, twice over" risk.

---

## clientStorage Schema

All keys are namespaced under a single top-level version marker so the
schema itself can evolve without clashing with prior installs. Total budget
target: well under the 5 MB quota, with snippets as the dominant, unbounded
element — the schema below includes an explicit size guard for that reason.

```ts
// clientStorage key: "flowfig:v1:settings"
interface PluginSettings {
  schemaVersion: 1
  fuzzyMatch: 'auto-bind-exact' | 'confirm-all'   // default: 'auto-bind-exact'
  lastScrapeAt?: string                            // ISO timestamp, informational only
}

// clientStorage key: "flowfig:v1:snippets:index"
interface SnippetIndex {
  schemaVersion: 1
  ids: string[]           // ordered list; snippet bodies stored separately (see below)
  totalBytesApprox: number // running estimate against the 5 MB quota
}

// clientStorage key: "flowfig:v1:snippet:<id>"
interface Snippet {
  id: string                // uuid, also the storage key suffix
  schemaVersion: 1
  name: string
  createdAt: string          // ISO timestamp
  source: 'capture' | 'generated' | 'manual'
  formatVersion: string      // the flowfig file-format version this snippet was captured under
  tree: TranslatedNodeTree   // same shape as a *.translated.flowfig.json node subtree
}
```

Design notes:

- **Snippets are stored one-key-per-snippet**, indexed by `SnippetIndex`,
  rather than one giant array under a single key — `clientStorage`'s quota
  math is per key+value, so splitting avoids ever needing to
  read-modify-write a single multi-megabyte blob for a one-snippet change,
  and lets us evict individual snippets cheaply.
- **`totalBytesApprox`** is maintained on every write (key size + JSON byte
  length of the value, per the documented quota formula) so the UI can warn
  *before* a `setAsync` rejects outright, rather than surfacing Figma's own
  quota error as an unexplained failure.
- **Every persisted record carries its own `schemaVersion`**, independent of
  the file-format `formatVersion` used for imported trees — clientStorage
  schema and file-interchange schema are allowed to evolve on different
  clocks, and mixing them would make the hard-reject policy (N4) leak into
  a place it doesn't need to apply (old snippets should degrade gracefully
  on a plugin update, not hard-fail the way a version-mismatched *import
  file* does).
- Settings default (`fuzzyMatch: 'auto-bind-exact'`) is written on first
  run if `getAsync('flowfig:v1:settings')` returns `undefined` — never
  assumed in code paths that read it later.

---

## Import UX Flow

1. **Invoke.** User runs the "flowfig: Import…" command from the plugin
   menu (registered via the `menu` config). The UI iframe opens with a
   `FilePicker`.
2. **Select file.** User picks (or drags) a `*.flowfig.json` file via
   `<input type="file">`. The UI reads it client-side with `FileReader`
   (main thread cannot touch the filesystem — Research Findings §2) and
   posts `{ type: 'import-file', kind, fileContents }` to the main thread.
   `kind` is inferred from the filename suffix (`.capture.flowfig.json` vs
   `.translated.flowfig.json`) with a content-shape sanity check as a
   backstop in case a user renames a file.
3. **Version gate (F3/N4).** Main thread parses just enough to read
   `formatVersion`. Mismatch → post `version-rejected` immediately with the
   specific expected/actual versions; UI shows the "this file needs a newer
   plugin version — check Figma Community" message (N6) and stops. No
   further parsing happens on a version mismatch.
4. **Translate (capture files only).** For `kind: 'capture'`, main thread
   calls `@flowfig/core`'s `translate()` against a freshly-built live
   symbol snapshot (not the on-disk `.flowfig/symbols.json`, per N5) to
   produce the same `TranslatedNodeTree` shape a `.translated` file would
   already contain. `kind: 'translated'` files skip straight to this
   shape.
5. **Plan (F10).** Main thread calls `writeTree(...)` in plan mode — no
   canvas mutation yet — and posts `outcomes-ready` with the full list of
   `ResolutionOutcome`s.
6. **Review.** UI renders `OutcomeList`, grouped by the six outcome kinds.
   Concretely:
   - *Key-resolved* items are shown collapsed/informational (nothing to
     decide) unless `settings.fuzzyMatch === 'confirm-all'` also happens to
     gate exact key matches — note per F8/Decision #2, the confirm-all
     toggle governs **fuzzy exact matches**, not tagged key-resolution;
     tagged refs that resolve are always the happy path with no review
     needed, since there's no ambiguity to confirm.
   - *Key-missing* items block: user must acknowledge/skip that node or
     cancel the whole import — there is nothing to auto-resolve.
   - *Key-new* items show a diff of the subtree that will become a new
     component, with the proposed component name, before creation.
   - *Fuzzy-exact* items are pre-checked/auto-approved unless
     `confirm-all` is set, per F8.
   - *Fuzzy-close* items always show the suggested match plus a "use
     literal value instead" escape hatch — always a genuine judgment call
     per the root plan.
   - *Fuzzy-none* items require a per-item choice: literal value or mint a
     new token.
7. **Confirm.** User adjusts any decisions and clicks Import. UI posts
   `{ type: 'confirm-outcomes', decisions }`.
8. **Commit.** Main thread runs `commitWrite(outcomes, decisions)`,
   performing the actual `figma.*` calls: binds/instantiates for resolved
   keys, creates+registers for new components (writing the fresh key into
   the in-memory `LiveSymbolSnapshot` and queuing it for the next
   `.flowfig/symbols.json` write-back per F7), applies chosen bindings or
   literal values for fuzzy outcomes.
9. **Report.** Main thread posts `write-complete` with a summary (counts
   per outcome kind, any nodes skipped); UI shows a completion state.
   Any node-writer exception surfaces as `write-error` with which node/ref
   failed, not a blanket failure.

---

## Symbol Table Scraper Design

### What it walks

- **Components & component sets** — `figma.root` (or current page,
  configurable) traversal collecting every `ComponentNode`/
  `ComponentSetNode`, recording `key`, `name`, variant properties (for
  sets), and a structural summary of exposed properties (for future
  prop-driven instancing).
- **Variables & collections** — `figma.variables.getLocalVariableCollectionsAsync()`
  → for each collection, its variables, modes, and per-mode values.
- **Styles** — local paint/text/effect/grid styles, each with `key`,
  `name`, and a resolved-value summary (so untagged fuzzy-matching in
  `@flowfig/core` has literal values to compare against, not just names).

The scraper reads live via the Plugin API every time it runs — it never
reads back its own prior export. That would risk exactly the staleness
problem the Node Writer's live re-verification (N5) is designed to route
around at write time; the scraper's entire job is to *produce* the fresh
snapshot, not consume an old one.

### `.flowfig/symbols.json` shape

```json
{
  "formatVersion": "1.0.0",
  "scrapedAt": "2026-07-18T00:00:00.000Z",
  "fileKey": "abcFileKey123",
  "fileName": "Design System — Core",
  "components": [
    {
      "key": "a1b2c3d4e5f6",
      "name": "Button",
      "type": "component",
      "properties": {
        "size": { "type": "VARIANT", "options": ["sm", "md", "lg"] },
        "label": { "type": "TEXT", "default": "Button" },
        "icon": { "type": "INSTANCE_SWAP", "options": [] }
      },
      "variantOf": null
    },
    {
      "key": "f6e5d4c3b2a1",
      "name": "Card/Header",
      "type": "component",
      "properties": {},
      "variantOf": null
    }
  ],
  "variables": [
    {
      "id": "VariableID:1:23",
      "key": "b2c3d4e5f6a1",
      "name": "color/accent/500",
      "collection": "Core Tokens",
      "resolvedType": "COLOR",
      "modes": {
        "Light": { "r": 0.98, "g": 0.31, "b": 0.15, "a": 1 },
        "Dark":  { "r": 0.91, "g": 0.24, "b": 0.10, "a": 1 }
      },
      "scopes": ["ALL_FILLS"]
    },
    {
      "id": "VariableID:1:24",
      "key": "c3d4e5f6a1b2",
      "name": "spacing/md",
      "collection": "Core Tokens",
      "resolvedType": "FLOAT",
      "modes": { "Value": 16 },
      "scopes": ["GAP", "WIDTH_HEIGHT"]
    }
  ],
  "styles": [
    {
      "key": "d4e5f6a1b2c3",
      "name": "Heading/H1",
      "type": "TEXT",
      "resolved": {
        "fontFamily": "Inter",
        "fontWeight": 700,
        "fontSize": 32,
        "lineHeight": { "unit": "PERCENT", "value": 120 }
      }
    }
  ]
}
```

Notes on the shape:

- `formatVersion` here is the **symbol-table format's own version**, tracked
  independently from the imported-file `formatVersion` (they can drift at
  different rates — the symbol table is plugin-produced and read only by
  trusted in-repo consumers, so its versioning policy can be looser than
  the hard-reject rule applied to user-facing import files, though it
  should still be checked by readers).
- `fileKey`/`fileName`/`scrapedAt` let `agent-kit` and the agent sanity-check
  which file a symbol table came from and how fresh it is — useful context
  even though the Writer itself never trusts this file for the actual write
  (N5).
- `components[].properties` captures enough of each component's variant/
  property surface for the agent to generate `data-flowfig-props` that will
  actually apply cleanly, not just a name.
- `variables[].modes` stores literal per-mode values (not just IDs) so
  `@flowfig/core`'s fuzzy matcher has real values for comparison — matching
  "this computed color" against "this token" requires the token's resolved
  value, not just its name.
- Write-back (F7) is an **in-place patch to this same shape** immediately
  after a new component is created mid-import, followed by rewriting the
  file on the next explicit Scrape (or immediately, if we choose to have
  Import trigger a scoped re-scrape of just the newly-added entries — left
  as an open question, see Risks).

---

## Phase Task Breakdown (P1)

Ordered; later tasks assume earlier ones are done. Each roughly maps to a
buildable, testable increment.

1. **Scaffold.** `npx create-figma-plugin@latest`-equivalent setup by hand:
   `package.json` `figma-plugin` config (three menu commands), `tsconfig.json`
   extending the repo base, `@create-figma-plugin/build` +
   `@figma/plugin-typings` devDependencies. Verify `npm run build` produces
   a loadable `manifest.json` + `build/` with a trivial "hello world" main/ui
   before writing any real logic.
2. **Shared types.** `src/shared/types.ts` — message unions,
   `ResolutionOutcome`, `PluginSettings`, `Snippet`, `SymbolTable` shape
   (aligned with whatever `@flowfig/core` exposes for file-format types —
   coordinate here since core is being architected in parallel; don't
   invent a competing shape).
3. **clientStorage wrapper + Settings command.** Typed
   `src/main/storage/client-storage.ts`, default-on-first-run settings, the
   Settings UI (fuzzy-match toggle at minimum; snippet manager can follow
   once snippets exist). This is small and unblocks nothing else, but it's
   low-risk and validates the main⇄UI messaging plumbing early.
4. **Scraper.** `src/main/scraper/**` walking components → variables →
   styles, producing the `.flowfig/symbols.json` shape above, with the
   Scrape UI triggering a browser download. This is explicitly prioritized
   before the Writer per the root plan ("Nothing downstream is useful
   without this existing first") — the Writer's key-resolution path and
   agent-kit's tagging both need real symbol-table shape to test against.
5. **Fixtures.** Hand-build a handful of `*.capture.flowfig.json` and
   `*.translated.flowfig.json` fixtures in `fixtures/`, covering: a simple
   tagged component reference, a `data-flowfig-new-component`, an untagged
   node with an exact-matchable value, an untagged node with only a
   close/no match, and a deliberately-mismatched `formatVersion` file for
   the rejection path. Shared with `@flowfig/core`'s own test suite where
   possible so both packages validate against one contract (per the root
   plan's `examples/` convention).
6. **Node Writer — key resolution.** `key-resolution.ts` +
   `component-writer.ts` + `variable-writer.ts`, proven against the tagged
   fixtures. Cover all three outcomes explicitly in tests: resolves,
   missing-from-file, explicitly-new-with-key-write-back.
7. **Node Writer — fuzzy resolution.** `fuzzy-resolution.ts`, calling into
   whatever `@flowfig/core`'s matching module exposes, proven against the
   untagged fixtures. Cover all three outcomes: exact, close, none —
   including both settings values for the exact-match path.
8. **Text/font handling.** `text-writer.ts` with `loadFontAsync` +
   fallback-mapping table; test against a fixture that references a font
   unlikely to be present in a CI/test context, to exercise the fallback
   path deliberately rather than by accident.
9. **Import UI end-to-end.** Wire `import.ui.tsx`'s `FilePicker` →
   `OutcomeList` → confirm → `write-complete`, using the plan/commit
   two-phase writer API. This is the first point real manual
   click-through testing inside actual Figma is required (everything
   before this is unit-testable with a mocked `figma` global).
10. **Write-back into the symbol table.** Confirm F7 end-to-end: import a
    fixture with a `data-flowfig-new-component`, verify the created key
    gets merged into the in-memory snapshot and reflected in the next
    Scrape's output.
11. **Version-mismatch UX pass.** Deliberately exercise F3/N4/N6: craft a
    fixture with a bumped `formatVersion` and verify the specific
    actionable error text end-to-end, not just that it errors.
12. **Pre-submission QA pass against Figma's stated rejection reasons**
    (Research Findings §4): no crashes on malformed input, no long-running
    unyielded work on the main thread, description copy matches actual
    behavior, manifest permissions match actual usage exactly (no
    over-broad `networkAccess` or unused `permissions` entries — both
    slow down review and widen the plugin's attack surface for no
    benefit).
13. **Submit to Figma Community review**, budgeting for the realistic
    multi-week tail documented in Research Findings §4, not the
    best-case 5–10 business days.

---

## Open Risks / Questions

1. **Review-latency-induced schema skew is real and already
   observed-in-the-wild** (1–1.5+ month reviews reported), not a
   theoretical worry. The hard-reject policy protects correctness but
   means a shipped agent-kit bump can leave users unable to import for
   however long re-review takes. Worth deciding: should agent-kit be able
   to *target* an older, already-approved `formatVersion` on request (a
   compatibility flag), even though the plugin itself never does
   best-effort migration? That would live in agent-kit/core, not here, but
   this package's hard-reject stance is the reason it'd be needed.
2. **Write-back timing is unresolved.** Does creating a new component
   mid-import (F7) trigger an immediate partial re-scrape, or only patch
   the in-memory snapshot for the rest of *that* import run, leaving the
   on-disk `.flowfig/symbols.json` stale until the user explicitly runs
   Scrape again? The latter is simpler but means agent-kit could read a
   symbol table that's missing a component that visibly exists in the
   file it was scraped from moments ago. Leaning toward: patch in-memory
   for the current run (needed regardless, for outcome correctness within
   one import), and prompt the user post-import ("New components were
   created — re-run Scrape to update the symbol table") rather than
   silently auto-writing to disk from the main thread (which can't touch
   disk directly anyway — see Research Findings §2 — so any "auto-write"
   would itself be a UI-triggered download, arguably better as an explicit
   user action).
3. **`teamlibrary` permission with no P1 exercise path.** We're declaring
   it from day one on the theory that adding it later costs a re-review
   cycle. Worth confirming this reasoning holds once `@flowfig/core`'s
   real matching/format modules land — if P1 truly never resolves against
   a published library (only the same-file case), consider deferring the
   permission to P2/P3 instead, trading a future re-review for a
   narrower P1 review footprint. Currently unresolved which way nets out
   cheaper.
4. **Font fallback-mapping table has no defined source yet.** `text-writer.ts`
   needs a concrete fallback table (which font substitutes for which), and
   nothing in the root plan or this research specifies where that table's
   data comes from (hardcoded common-fonts list vs. user-configurable vs.
   sourced from `@flowfig/core`). Needs a decision before task 8 in the
   breakdown above is actually implementable, not just stubbable.
5. **`@flowfig/core`'s actual exposed API surface is assumed, not
   confirmed.** This document assumes `core` exposes `translate()`, a
   matching module with a `match(value, symbolTable)`-shaped entry point,
   and file-format types compatible with the `TranslatedNodeTree`/
   `SymbolTable` shapes sketched here. Since core is being architected in
   parallel, the shared-types task (breakdown task 2) is the point where
   this needs to be reconciled against core's real design, not this
   package's guess at it.
6. **Bundle-size/perf ceiling for the main thread is untested.** No
   research surfaced a documented hard limit on main-thread plugin bundle
   size or execution time (beyond "don't block the UI" being a stated
   rejection criterion), so the Node Writer's tree-walking on large
   imports is a performance unknown until tested against a realistically
   large fixture — worth adding a "large fixture" stress test rather than
   only small hand-built ones in task 5.
