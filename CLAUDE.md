# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

flowfig turns two kinds of source — an existing live web page, or AI-agent-generated code — into real, editable Figma nodes, through one shared JSON file format and one writer that's ever allowed to touch the Figma API. **Read `Documentation/MISSION.md` before making any architectural judgment call** — it lists the project's non-negotiables (only `figma-plugin`'s Node Writer calls `figma.*`, file hand-offs only, no hosted backend, hard-reject `formatVersion` mismatches, etc.) and what's explicitly out of scope for v1. If a change doesn't trace back to that page, check `Documentation/PROJECT-TRACKING.md` before assuming it's in scope.

## Documentation map

Don't duplicate detail from these into new docs — extend the right one instead:

- **`Documentation/MISSION.md`** — north star and non-negotiables.
- **`Documentation/architecture-plan.md`** — the full pipeline, the three file kinds, the tagging convention, the publish matrix, and resolved product decisions (snippet storage, fuzzy-match settings, formatVersion policy, plugin build tooling).
- **`Documentation/PROJECT-TRACKING.md`** — phase status (P0–P5), condensed requirements checklists, the cross-package contract-reconciliation blocking gate, and a consolidated risk register. Check this for what's actually built vs. only planned.
- **`packages/*/ARCHITECTURE.md`** — one per package, each a concrete, research-backed implementation plan (module layout, key types, ordered task breakdown, open risks) for that package specifically.

## Current state (as of this writing)

Only `packages/figma-plugin` has real scaffolded code: `@create-figma-plugin` build tooling plus three trivial menu-command stubs (Import…, Scrape symbol table, Settings) that just call `figma.showUI`. `core`, `agent-kit`, and `extension` are still empty `package.json` workspace stubs with only an `ARCHITECTURE.md` each — no source code. Don't assume any package beyond `figma-plugin`'s scaffold has working code without checking.

**Do not start real Node Writer/scraper/CLI/collector logic against `@flowfig/core` without first checking the blocking gate in `Documentation/PROJECT-TRACKING.md`.** `core`, `figma-plugin`, `extension`, and `agent-kit`'s architecture docs were written in parallel before `core` existed, so `figma-plugin`, `extension`, and `agent-kit` each independently guessed at two shared contracts (the DOM snapshot shape, and the symbol-table shape) — the guesses genuinely diverge. That gate needs to close before those contracts are treated as settled.

## Commands

This is an npm-workspaces monorepo (`packages/*`). Run from the repo root:

```
npm install                                          # installs all workspace packages
npm run build --workspace=@flowfig/figma-plugin       # build-figma-plugin --typecheck --minify
npm run watch --workspace=@flowfig/figma-plugin       # build-figma-plugin --typecheck --watch
npm run typecheck --workspace=@flowfig/figma-plugin   # tsc --noEmit
```

Root-level `npm run build`/`test`/`typecheck` are currently no-op placeholders (`echo "no packages to build yet"`) — they haven't been wired to fan out to workspaces yet. Don't expect them to do anything real yet; use the `--workspace=` form for the package you're actually touching.

No test runner is configured anywhere yet. `packages/core/ARCHITECTURE.md` specifies Vitest as its P0 task 1 — that hasn't landed yet.

**Do not bump the root `typescript` devDependency past the 5.x line without checking.** It's pinned to `^5.9.3` deliberately: `@create-figma-plugin/build` claims a `>=5` peer dependency but is actually incompatible with TypeScript 7 (a breaking architectural rewrite) — `ts.sys` comes back `undefined` and the build crashes. This was hit and fixed once already; don't re-introduce it by trusting `npm view typescript version`/"latest" blindly.

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

**`figma-plugin` package internals** (the only package with real code right now): built on `@create-figma-plugin`, where `manifest.json` is a **generated build artifact** — config lives under the `"figma-plugin"` key in `package.json` and gets regenerated on every build; never hand-edit `manifest.json` directly (it's gitignored). The package uses **Preact**, not React (the toolkit's `@create-figma-plugin/ui` component library — prebuilt, Figma-look-alike components — only exists for Preact). Code splits strictly into `src/main/*.main.ts` (the only files allowed to reference the `figma` global — main thread) and `src/ui/*.ui.tsx` (the only files allowed to touch the DOM — UI iframe); the two sides can only communicate via `postMessage`, per Figma's plugin sandbox architecture. Multiple menu commands (Import…, Scrape symbol table, Settings) are registered via the `"menu"` array in `package.json` and share one bundle — see `packages/figma-plugin/ARCHITECTURE.md` for the full Node Writer/scraper/clientStorage design once that code gets built.
