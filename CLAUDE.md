# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

flowfig turns two kinds of source — an existing live web page, or AI-agent-generated code — into real, editable Figma nodes, through one shared JSON file format and one writer that's ever allowed to touch the Figma API. **Read `Documentation/MISSION.md` before making any architectural judgment call** — it lists the project's non-negotiables (only `figma-plugin`'s Node Writer calls `figma.*`, file hand-offs only, no hosted backend, hard-reject `formatVersion` mismatches, etc.) and what's explicitly out of scope for v1. If a change doesn't trace back to that page, check `Documentation/PROJECT-TRACKING.md` before assuming it's in scope.

## Before making changes

Read the relevant docs from the map below and inspect the actual folder structure (`ls`/`find` on `packages/*` and `Documentation/`) before assuming what exists — this repo has four packages at very different stages of completion, and the docs describe plans that don't all match what's on disk yet (see "Current state" below). Don't infer a package's contents from its `ARCHITECTURE.md` alone; check its actual files.

## Documentation map

Don't duplicate detail from these into new docs — extend the right one instead:

- **`Documentation/MISSION.md`** — north star and non-negotiables.
- **`Documentation/architecture-plan.md`** — the full pipeline, the three file kinds, the tagging convention, the publish matrix, and resolved product decisions (snippet storage, fuzzy-match settings, formatVersion policy, plugin build tooling).
- **`Documentation/PROJECT-TRACKING.md`** — phase status (P0–P5), condensed requirements checklists, the cross-package contract-reconciliation blocking gate, and a consolidated risk register. Check this for what's actually built vs. only planned.
- **`packages/*/ARCHITECTURE.md`** — one per package, each a concrete, research-backed implementation plan (module layout, key types, ordered task breakdown, open risks) for that package specifically.

## Current state (as of this writing)

`packages/figma-plugin` has real scaffolded code: `@create-figma-plugin` build tooling plus three trivial menu-command stubs (Import…, Scrape symbol table, Settings) that just call `figma.showUI`. `packages/core` has started on its P0 task list (see `Documentation/PROJECT-TRACKING.md`): `format/`, `resolver/`, `translator/`, and `matching/`'s `types.ts` files exist and typecheck against each other (the cross-package contract reconciliation from the blocking gate below is folded into these types, not left as a TODO), plus `format/errors.ts` + `format/validate.ts` with unit tests. No resolver/translator/matching *logic* exists yet — only types, barrels, and format validation. `agent-kit` and `extension` are still empty `package.json` workspace stubs with only an `ARCHITECTURE.md` each — no source code. Don't assume a package has more working code than this without checking.

**`core`'s remaining P0 tasks still block real Node Writer/scraper/CLI/collector logic in the other three packages** — the types existing doesn't mean the resolver/translator/matching functions are implemented yet. Check `packages/core/ARCHITECTURE.md`'s Phase Task Breakdown (P0) for what's actually done vs. still open before building against it.

## Root-level module conventions (apply repo-wide, not just `core`)

- **Named exports only, no default exports**, anywhere — including barrels (`export * from './file.js'` or explicit named re-exports, never `export { default }`). Chosen so re-exporting through a package's public surface never needs renaming gymnastics later.
- **`tsconfig.base.json` is `"module": "NodeNext"`** — every relative import needs an explicit `.js` extension even in `.ts` source (e.g. `from './types.js'`), or `tsc` hard-errors. This is already in effect repo-wide, not just a `core` convention.
- **Per-module-folder barrels**: a package that splits into concern-based folders (see `core`'s `format/`/`resolver/`/`translator/`/`matching/` below) gives each folder its own `index.ts` barrel re-exporting that folder's files, plus one root `src/index.ts` re-exporting all the folder barrels. This is what lets a consumer import a narrow sub-path (e.g. `@flowfig/core/matching`) without pulling in the whole package, without restructuring later.
- **ESLint enforces `core`'s runtime-agnosticism**, not just convention: `eslint.config.js` has a `packages/core/src/**` block (excluding `*.spec.ts`) that zeroes out all ambient globals and adds `no-restricted-globals`/`no-restricted-imports` for `figma`, `chrome`, and `node:*`/Node built-ins. If you need a Node/browser/Figma API inside `core`, that's a sign the code belongs in a consumer package instead.

## Commands

This is an npm-workspaces monorepo (`packages/*`). Run from the repo root:

```
npm install                       # installs all workspace packages
npm run build                     # fans out `build` to every workspace that defines it (--if-present)
npm run test                      # fans out `test` to every workspace that defines it (--if-present)
npm run typecheck                 # fans out `typecheck` to every workspace that defines it (--if-present)
npm run lint                      # eslint . (flat config, repo-wide)
npm run format                    # prettier --write .
```

Root `build`/`test`/`typecheck` now genuinely fan out via `--workspaces --if-present` — no longer no-op placeholders. Use `--workspace=@flowfig/<name>` instead of the root script when you only want one package's output (faster, less noise), e.g.:

```
npm run build --workspace=@flowfig/figma-plugin       # build-figma-plugin --typecheck --minify
npm run watch --workspace=@flowfig/figma-plugin       # build-figma-plugin --typecheck --watch
npm run test --workspace=@flowfig/core                # vitest run
npm run test:watch --workspace=@flowfig/core           # vitest (watch mode)
```

`core` is the only package with a test runner configured so far (Vitest). Test files are colocated as `<name>.spec.ts` next to the source they cover (e.g. `format/validate.spec.ts`), except golden-file fixture tests, which live under `core`'s own `test/` per its `ARCHITECTURE.md`.

**Do not bump the root `typescript` devDependency past the 5.x line without checking.** It's pinned to `^5.9.3` deliberately: `@create-figma-plugin/build` claims a `>=5` peer dependency but is actually incompatible with TypeScript 7 (a breaking architectural rewrite) — `ts.sys` comes back `undefined` and the build crashes. This was hit and fixed once already; don't re-introduce it by trusting `npm view typescript version`/"latest" blindly.

**Running `npm run build --workspace=@flowfig/figma-plugin` (or the root fan-out) regenerates `packages/figma-plugin/manifest.json`** and will show up as a `git diff` even though nothing about the plugin's behavior changed — it's a tracked generated artifact (see below). Revert it after a verification build if you didn't mean to touch it.

## Architecture

**Two producers, one bridge, one writer** is the idea everything else follows from:

- Producer A (`extension`, P3) captures pages that already exist, via a real browser tab's `getComputedStyle()`/`getBoundingClientRect()`.
- Producer B (`agent-kit`, P2) captures AI-agent-generated code via a headless Playwright render (no browser tab of its own).
- Both produce files, never a live connection — capture/generate → JSON file → import.
- `figma-plugin` (P1) is the only package ever allowed to call `figma.*`. It imports either file kind, resolves tagged/untagged refs, writes real nodes, and scrapes the open file's components/variables/styles back into a symbol table the other two producers read off disk.
- `core` (P0) is the private, never-published library all three others depend on: the JSON format types, the resolver (raw snapshot → normalized tree), the translator (resolved tree + tags + symbol table → tagged tree), and fuzzy/structural matching. It has zero dependency on `figma`, `chrome.*`, or Node built-ins so each consumer's own bundler can compile it for its own runtime.

**The three file kinds** (full shapes in `core/ARCHITECTURE.md`'s `format/types.ts` section):
- `*.capture.flowfig.json` — from `extension`, resolved but untranslated (arbitrary CSS, no tag guarantees).
- `*.translated.flowfig.json` — from `agent-kit`, already translated with tagged component/token refs.
- `.flowfig/symbols.json` — from `figma-plugin`'s scraper, the live symbol table `agent-kit` and the coding agent read back.

**Tagging convention** a coding agent uses to reference real Figma objects by stable key rather than a driftable name: `data-flowfig-component="<key>"` (+ optional `data-flowfig-props='{"...json..."}'`), `data-flowfig-new-component="<Name>"`, and `--ffig-*` CSS custom properties as token refs. Untagged elements/values still work via fuzzy matching — tagging isn't all-or-nothing per file.

**Every file carries a `formatVersion`; mismatches hard-reject, never a best-effort migration** — this shows up as a hard requirement in all four package docs, not just `figma-plugin`.

**`figma-plugin` package internals** (the only package with real code right now): built on `@create-figma-plugin`, where `manifest.json` is a **generated build artifact** — config lives under the `"figma-plugin"` key in `package.json` and gets regenerated on every build; never hand-edit `manifest.json` directly. Note it's currently tracked in git (committed alongside the initial scaffold) despite being generated — don't assume `.gitignore` keeps it out of diffs; check `git status` after a build. The package uses **Preact**, not React (the toolkit's `@create-figma-plugin/ui` component library — prebuilt, Figma-look-alike components — only exists for Preact). Code splits strictly into `src/main/*.main.ts` (the only files allowed to reference the `figma` global — main thread) and `src/ui/*.ui.tsx` (the only files allowed to touch the DOM — UI iframe); the two sides can only communicate via `postMessage`, per Figma's plugin sandbox architecture. Multiple menu commands (Import…, Scrape symbol table, Settings) are registered via the `"menu"` array in `package.json` and share one bundle — see `packages/figma-plugin/ARCHITECTURE.md` for the full Node Writer/scraper/clientStorage design once that code gets built.
