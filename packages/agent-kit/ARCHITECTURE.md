# `agent-kit` — Architecture

Status: planning document for P2 (not yet started — `@flowfig/core` is P0, `figma-plugin` is P1, both prerequisites). No source code exists yet; this document is the implementation plan.

---

## Purpose & Scope

`agent-kit` is the flagship, npm-published surface of flowfig: an installable CLI that any project adds so its own AI-coding-agent-generated code can be pushed straight into Figma. It is **Producer B** in the flowfig pipeline (see `Documentation/architecture-plan.md`) — the counterpart to the Chrome extension's live-page capture, but for code an agent just wrote rather than an arbitrary existing page.

Concretely, `agent-kit`:

1. Drives a **real, headless browser via Playwright** to render a target page/component and extract computed styles, layout geometry, and DOM structure — because it has no browser tab of its own to read from.
2. Feeds that snapshot into `@flowfig/core`'s `resolve()`, then `translate()`, using `.flowfig/symbols.json` (the plugin's exported symbol table) to resolve `data-flowfig-*` tags to real Figma component/variable keys.
3. Writes an already-translated `*.translated.flowfig.json` file, stamped with the current `formatVersion`.
4. Generates `docs/AGENT-GUIDE.md` — a guide *for the coding agent*, not a human, teaching it the tagging convention so future generated code is tagged correctly from the start.

**Out of scope for `agent-kit` itself** (owned elsewhere or deliberately deferred):
- Resolution/translation algorithms — those live in `@flowfig/core`; this package only drives Playwright and calls into core.
- Anything touching `figma.*` — only the plugin's Node Writer is allowed to do that.
- Font fallback *mapping* (which real Figma font substitutes for a missing one) — that's the plugin/Writer's problem. `agent-kit`'s job is *detection*: knowing when a font failed to load during rendering and saying so.
- Multi-viewport, interactive-state, hover/focus capture — explicit v1 boundary per the architecture plan.

---

## Requirements

### Functional

- FR1. `flowfig generate` renders one or more configured targets in a real browser and produces a valid `*.translated.flowfig.json` per target.
- FR2. Config is loaded from a `flowfig.config.{ts,mjs,json}` file (or `flowfig` key in `package.json`), validated, and merged with CLI flags (flags win).
- FR3. The tool reads `.flowfig/symbols.json`, validates its `formatVersion`, and passes it to `core.translate()` for key resolution. Missing/stale symbol table is a clear, actionable error, not a silent partial output.
- FR4. Every file `agent-kit` writes carries the package's current `formatVersion` constant — no attempt to read/write a different version than the one this build understands.
- FR5. `flowfig guide` (and implicitly `flowfig init`) generates/refreshes `docs/AGENT-GUIDE.md` from a single source of truth for the tagging convention (attribute names, `--ffig-*` prefix, JSON shape of `data-flowfig-props`) — never hand-duplicated prose that can drift from what `core`'s tag parser actually accepts.
- FR6. `flowfig doctor` inspects the local environment (browser binary presence, OS deps, symbol table presence/version, font reachability) and prints specific, actionable remediation — not a generic "run playwright install."
- FR7. Untagged elements still resolve via core's fuzzy-match path — `agent-kit` doesn't require full tagging to produce useful output.
- FR8. Font-loading failures during rendering are detected and surfaced (warn or hard-fail, per config) with the specific font-family name, not swallowed as a silent mis-measurement.

### Non-functional

- NFR1. **CI/sandbox-first**: the primary audience runs this inside constrained, often network-restricted agent sandboxes and CI, not a developer's laptop with a browser already open. Every failure mode must produce a diagnosable error, never a hang.
- NFR2. **Deterministic enough for fixture testing**: given a pinned Playwright/browser version and a fixed viewport, the same input HTML produces the same snapshot, so `examples/` fixtures can be asserted against byte-for-byte (modulo explicitly-allowed float tolerance in geometry).
- NFR3. **No duplicate resolution logic**: all cascade/translation semantics live in `@flowfig/core`; this package is CLI + Playwright driver + config + glue + guide generation only.
- NFR4. **Fails loudly on version skew**, consistent with the monorepo-wide hard-reject policy — never best-effort migrate a `formatVersion` mismatch.
- NFR5. Ships as a real npm package: reasonable install size/time for its *own* code (Playwright itself is unavoidably heavy — see Research Findings — but `agent-kit`'s own dependency surface beyond `@flowfig/core` and Playwright should stay minimal).
- NFR6. Usable via `npx @flowfig/agent-kit generate` without a global install, and as an installed devDependency with a `flowfig` bin.
- NFR7. TypeScript, ESM-first, Node LTS-current support.

---

## Research Findings

### 1. Playwright's API for computed style + geometry + DOM structure

`page.evaluate()` only returns **serializable plain values** — it copies data out of the browser context into Node, so any extraction must happen as a single in-page function that walks the DOM and returns a plain JSON-able object, not element handles (`evaluateHandle`/`ElementHandle` are for staying *in* the browser context, not for bulk extraction). This matters directly: the snapshot walker has to be one recursive in-page function returning `{tag, attributes, computedStyle, box, children}` nodes, run once per target render, not many small `evaluate()` round-trips (each round-trip is a serialization boundary and gets expensive at DOM scale).

`window.getComputedStyle(el)` gives all resolved CSS properties (as strings) for an element; `el.getBoundingClientRect()` gives layout geometry **relative to the viewport**, and is affected by scroll position, so the driver must ensure a fixed scroll position (0,0) and fixed viewport before measuring, matching the "one fixed viewport, one DOM state" v1 boundary already decided in the architecture plan. `getComputedStyle` returns on the order of 300–400 longhand properties; extracting all of them per node is wasteful and creates a huge, noisy contract surface — the walker should extract a **curated allowlist** relevant to layout/typography/paint (position, display, box model, flex/grid props, typography, color/background/border, opacity/transform) and let `@flowfig/core`'s resolver be the arbiter of exactly which properties it needs, analogous to how the Chrome extension's content script must expose the same allowlist from a live tab.

Implication for design: this doesn't fully specify the resolver's input contract (that's core's job), only confirms Playwright *can* produce the same categories of data (computed style, geometry, DOM tree) that a live tab's `getComputedStyle`/`getBoundingClientRect` produce — so the two producers *can* converge on one shape. See "Playwright Snapshot Contract" below for the coordination plan.

Sources: [Playwright ElementHandle docs](https://playwright.dev/docs/api/class-elementhandle), [Playwright page.evaluate() reference](https://qaskills.sh/blog/playwright-page-evaluate-complete-guide), [Get CSS properties of web element with Playwright](https://shiv-jirwankar.medium.com/get-css-properties-of-web-element-with-playwright-e092fdc9f462).

### 2. Playwright footprint in CI/Docker

- The official Playwright Docker image ships Chromium/Firefox/WebKit **plus system deps pre-installed** at `/ms-playwright`; overriding `PLAYWRIGHT_BROWSERS_PATH` in that image forces a wasteful re-download per run.
- **Shared memory**: Docker's default `/dev/shm` is 64MB, too small for Chromium, causing crashes on non-trivial pages. Fix: `--shm-size=1gb` (or `--disable-dev-shm-usage` launch arg) in constrained containers.
- **`npm install` vs `npm ci`**: if CI caches `node_modules` and runs `npm install` (not `npm ci`), the Playwright package can be found on disk without its `postinstall` step re-running, silently leaving browser binaries missing.
- **Version pinning**: if the installed Playwright *npm package* version and the *downloaded browser* version diverge (e.g. a bumped dependency without re-running install), Playwright can't locate the browser executable — this is a real, recurring failure mode, not a hypothetical.
- Browser binaries and OS-level shared libraries are **cached and verified independently**: a cached `PLAYWRIGHT_BROWSERS_PATH` directory does not imply `install-deps` was run — Linux launch failures from missing shared libs happen even with the binary present on disk.

Sources: [Playwright Docker docs](https://playwright.dev/docs/docker), [Playwright Docker guide (Autonoma)](https://getautonoma.com/blog/playwright-docker-guide), [Playwright CI docs](https://playwright.dev/docs/ci), [Caching Playwright browsers in GitHub Actions](https://qaskills.sh/blog/github-actions-cache-playwright-browsers), [Playwright browsers path guide](https://qaskills.sh/blog/playwright-browsers-path-env-guide).

### 3. Playwright specifically inside AI-agent sandboxes (the audience that matters most here)

This is the most load-bearing finding, and it's specific, not generic. A documented, live GitHub issue (`microsoft/playwright#39934`) describes `playwright install --with-deps chromium` **failing inside a Claude-Code-style agent sandbox** with:

```
Error: getaddrinfo EAI_AGAIN storage.googleapis.com
```

Root cause is a **circular DNS-via-proxy problem**, not a simple "no internet" block: Node's `HttpsProxyAgent` needs to resolve the *proxy's own hostname* via local DNS to reach it, but sandboxes of this kind block direct DNS resolution and only allow proxy-mediated lookups (the way `curl` does it) — so `HTTPS_PROXY`/`HTTP_PROXY` being set correctly is not sufficient; the failure happens before the proxy is even reachable. Two real workarounds surfaced: (a) use an **IP-address proxy** instead of a hostname (`HttpsProxyAgent` handles IP-based proxies fine), or (b) manually fetch the browser archive with `curl` (which resolves DNS correctly in these sandboxes) from `cdn.playwright.dev` and unpack it directly into `~/.cache/ms-playwright/`, bypassing `playwright install`'s own downloader entirely.

More generally: agent sandboxes are frequently **network-disabled by default after an initial setup phase** — meaning the correct place to install Playwright's browser is during environment/image setup (while network is still open), never lazily at task-run time. This directly validates the roadmap's "document explicitly in the agent guide, not assumed to just work" callout — it isn't boilerplate advice, it's a specific, reproducible failure this package's actual users will hit.

Sources: [playwright#39934 — install fails in Claude Code Sandbox](https://github.com/microsoft/playwright/issues/39934), [Browser Tools for AI Agents (DEV)](https://dev.to/stevengonsalvez/browser-tools-for-ai-agents-part-1-playwright-puppeteer-and-why-your-agent-picked-playwright-k71), [Playwright docs — Browsers](https://playwright.dev/docs/browsers).

### 4. CLI framework choice

Commander (~35M weekly downloads, zero runtime dependencies) is the pragmatic default for a 3–15 subcommand TypeScript CLI: minimal API surface, fast startup (~18ms vs yargs ~35ms vs oclif ~85ms for trivial invocations in one benchmark), and no imposed project structure. yargs adds a middleware/coercion layer that's nice for complex flag validation but isn't needed at `agent-kit`'s expected command count (`generate`, `init`, `guide`, `doctor`, `symbols`). oclif is a full framework (plugin system, scaffolding, ~30 dependencies) aimed at CLIs that expect a plugin ecosystem or many independently-versioned subcommand packages — not warranted for a v1 flagship CLI with a fixed, small command set. **Decision: Commander**, revisit only if `agent-kit` grows a genuine third-party plugin model.

For config loading, the common convention among comparable dev-tool CLIs (Vite, ESLint, Tailwind, etc.) is a `<tool>.config.{ts,js,mjs,json}` file resolved by a small loader that supports TypeScript without requiring the *consuming* project to have a build step (e.g. via `jiti`/`bundle-require`-style on-the-fly transpilation), with a fallback to a `package.json` key. `agent-kit` should follow this convention exactly (`flowfig.config.ts` primary, `.flowfig`/`flowfig` package.json key fallback) rather than invent a new one.

Sources: [CLI Framework Comparison — Commander vs Yargs vs Oclif](https://www.grizzlypeaksoftware.com/library/cli-framework-comparison-commander-vs-yargs-vs-oclif-utxlf9v9), [Building a production TypeScript CLI in 2026 (DEV)](https://dev.to/thegdsks/building-a-production-typescript-cli-in-2026-oclif-vs-commander-vs-custom-9ah), [commander vs oclif vs vorpal vs yargs](https://npm-compare.com/commander,oclif,vorpal,yargs).

### 5. Agent-facing documentation conventions (AGENT-GUIDE.md's writing register)

Two adjacent-but-distinct conventions exist:

- **`AGENTS.md`** (originated at OpenAI's Codex team, donated to the Agentic AI Foundation under the Linux Foundation, Dec 2025): a repo-root markdown "briefing packet" for coding agents — build/test commands, conventions — deliberately separate from a human-oriented `README.md` because agent-relevant detail (exact commands, exact conventions) would clutter human docs and vice versa.
- **`llms.txt`**: closer to a `sitemap.xml` for LLM crawlers — a concise pointer file at a site's root listing which docs are worth indexing, not a content document itself.

`docs/AGENT-GUIDE.md` is closer in spirit to `AGENTS.md` than to `llms.txt`: it's a *content* document (the actual tagging rules), narrowly scoped to one concern (how to tag markup for flowfig) rather than whole-repo build/test instructions. The writing register that convention implies, and that this document adopts: **imperative, example-first, exact syntax over prose explanation, self-checkable** (an agent should be able to verify its own output against the guide without needing to ask a human), and terse — cut anything that doesn't change what the agent does next. If a consuming project already has its own `AGENTS.md`, `agent-kit`'s `init`/`guide` command should offer to append a one-line pointer to `docs/AGENT-GUIDE.md` there, the same way `llms.txt` points elsewhere rather than duplicating content.

Sources: [AGENTS.md — Factory docs](https://docs.factory.ai/cli/configuration/agents-md), [What Is AGENTS.md? (llms-txt.io)](https://llms-txt.io/blog/what-is-agents-md), [Add LLMS.txt on the agents.md website — issue #47](https://github.com/agentsmd/agents.md/issues/47).

### 6. Font-loading detection

`document.fonts` is a `FontFaceSet`; each `FontFace` exposes `.status` (`unloaded` | `loading` | `loaded` | `failed`). `document.fonts.ready` is a promise that resolves once pending font loads settle — but it resolves regardless of whether individual fonts *succeeded*, so waiting on it alone is not sufficient to detect a failure. Failures must be checked explicitly: iterate `document.fonts` after `ready` resolves and check each `FontFace.status === 'failed'`, and/or attach a `loadingerror` listener on the `FontFaceSet` beforehand ("fires when fonts have finished loading, but some or all fonts have failed to load"). Separately, Playwright's own `page.screenshot()` will itself block on in-flight font network requests by default (and can hang if those requests never resolve, e.g. in a network-restricted sandbox); a `PW_TEST_SCREENSHOT_NO_FONTS_READY` env var exists to bypass that specific screenshot-level wait, but that's the wrong tool here — `agent-kit` isn't taking screenshots for pixels, it *depends on* correct font metrics for intrinsic sizing, so it should do the opposite: explicitly wait for `document.fonts.ready` and *then* explicitly check status, converting a failure into a visible warning (or hard error per config) naming the specific font family — not bypass the wait.

Sources: [FontFaceSet: loadingerror event — MDN](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/loadingerror_event), [FontFace: load() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/FontFace/load), [CSS Font Loading API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Font_Loading_API), [How to Wait for Font Loading in Playwright Tests](https://testautomationmastery.com/how-to-wait-for-font-loading-to-ensure-complete-page-load-in-playwright-tests/), [playwright#35200 — flag to avoid loading fonts on screenshot](https://github.com/microsoft/playwright/issues/35200).

---

## Proposed Architecture

```
packages/agent-kit/
├── package.json               # bin: { flowfig: "./dist/cli/index.js" }, deps: @flowfig/core, playwright, commander
├── src/
│   ├── cli/
│   │   ├── index.ts           # commander program, registers subcommands, top-level error formatting
│   │   ├── generate.ts        # `flowfig generate` command
│   │   ├── init.ts            # `flowfig init` — scaffolds config + first AGENT-GUIDE.md + optional AGENTS.md pointer
│   │   ├── guide.ts            # `flowfig guide` — (re)generate docs/AGENT-GUIDE.md only
│   │   ├── doctor.ts           # `flowfig doctor` — environment diagnostics
│   │   └── symbols.ts          # `flowfig symbols check|show` — inspect .flowfig/symbols.json
│   ├── config/
│   │   ├── schema.ts           # zod (or similar) schema + defineConfig() helper for user config type-checking
│   │   ├── load.ts             # resolves flowfig.config.{ts,js,mjs,json} / package.json "flowfig" key
│   │   └── defaults.ts
│   ├── driver/
│   │   ├── browser.ts          # launch/close lifecycle, launch args (--disable-dev-shm-usage etc.), version pin check
│   │   ├── page.ts             # navigate, set viewport, wait for load + wait for document.fonts.ready
│   │   ├── fonts.ts            # post-ready FontFaceSet audit -> FontAuditResult[] (family, status, source url)
│   │   └── snapshot.ts         # invokes the shared DOM walker (see below), assembles the Snapshot envelope
│   ├── walker/
│   │   └── walk-dom.ts         # the in-page recursive extraction function — see "shared walker" note below;
│   │                           #   ideally re-exported from @flowfig/core once core exists, not owned here long-term
│   ├── pipeline/
│   │   ├── run.ts              # snapshot -> core.resolve() -> core.translate() -> write file, per target
│   │   └── write.ts            # stamps formatVersion, writes *.translated.flowfig.json, atomic write (tmp+rename)
│   ├── symbols/
│   │   └── load-symbols.ts     # reads .flowfig/symbols.json, validates formatVersion (hard-reject on mismatch)
│   ├── guide/
│   │   ├── generate-guide.ts   # renders docs/AGENT-GUIDE.md from convention-constants.ts + a template
│   │   └── convention-constants.ts  # single source of truth: attribute names, --ffig- prefix, prop JSON shape —
│   │                            #   imported from @flowfig/core's tag-parsing module once that exists, not redeclared
│   ├── diagnostics/
│   │   └── doctor-checks.ts    # each check in "Sandbox/Footprint Guidance" below as a discrete, named function
│   └── format-version.ts       # this build's supported formatVersion constant
├── docs/                       # not committed here — this is what `guide`/`init` writes into the CONSUMING project
├── ARCHITECTURE.md             # this file
└── README.md                   # human-facing package README (separate register from AGENT-GUIDE.md)
```

Key module boundaries:
- `driver/` knows Playwright and nothing about flowfig's file formats.
- `walker/` knows how to serialize a live DOM into plain JSON and nothing about Playwright (it's an in-page function; it could run in a real tab too — this is what makes contract alignment with the extension possible).
- `pipeline/` is the only place that imports `@flowfig/core` — it is pure glue: snapshot in, translated file out.
- `guide/` never encodes tagging rules as ad hoc prose; it renders them from `convention-constants.ts`, which should become a re-export from `@flowfig/core` as soon as core defines the tag-parsing module, so the guide can never say something the parser doesn't actually accept.

---

## Playwright Snapshot Contract

### Shape this package extracts

```ts
interface FlowfigSnapshot {
  formatVersion: string;
  source: "agent-kit";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  fontAudit: Array<{ family: string; status: "loaded" | "failed" | "unloaded" | "timeout" }>;
  root: SnapshotNode;
}

interface SnapshotNode {
  tag: string;                          // lowercase tag name
  attributes: Record<string, string>;   // verbatim, includes data-flowfig-* untouched
  text: string | null;                  // direct text content only when node has no element children
  computedStyle: Record<string, string>; // curated allowlist (see below), not the full ~400-prop CSSStyleDeclaration
  box: { x: number; y: number; width: number; height: number }; // getBoundingClientRect(), viewport-relative,
                                                                  // valid only because scroll is pinned to (0,0)
  children: SnapshotNode[];
}
```

The `computedStyle` allowlist (box model, flex/grid, typography, color/background/border/shadow, opacity/transform) is a first draft, not a final contract — see coordination note below.

### Keeping this aligned with the Chrome extension's content script

Neither `@flowfig/core`'s resolver input type nor the extension's content script exist yet, so this cannot be locked down unilaterally here. The coordination plan:

1. **The walker is code, not just a type.** Rather than each producer hand-writing its own DOM-to-JSON logic against a shared *type*, write the actual walking function (`walkDom(root: Element, options): SnapshotNode`) once, as a dependency-free, browser-safe module. Propose it live in `@flowfig/core` (e.g. `core/src/snapshot/walk-dom.ts`) as soon as core exists, since core already owns the format types it must consume. Both producers then call the *same function* — Playwright via `page.addScriptTag`/`page.evaluate` (bundled to a single IIFE string, since `evaluate()` can only serialize plain data back out, not share module scope with Node), the extension's content script via a normal bundler import. Zero duplicated tree-walking logic, and no way for the two shapes to silently diverge.
2. **Until core exists, treat this document's shape as an RFC**, not a commitment. The first P2 task (see Phase Task Breakdown) is explicitly to bring this proposal to whoever is designing `@flowfig/core`'s resolver input and get it accepted or revised *before* writing the driver against it.
3. **`examples/` fixtures are the executable contract.** Per the repo layout, `examples/` exists specifically to keep both adapters honest against one contract. Concretely: a fixture is a static HTML file; both `agent-kit` (via Playwright) and the extension (via a scripted "open this fixture in a real tab" test) must produce structurally equivalent `SnapshotNode` trees for it (allowing for expected divergences like scrollbar width). This is a stronger check than type-checking alone — it catches behavioral drift (e.g. one producer resolving a CSS custom property differently than the other).
4. **`source` field is deliberate.** Every snapshot self-identifies which producer made it (`"agent-kit"` vs. the extension's future equivalent), so `core.resolve()` can apply producer-specific tolerances if genuinely necessary (e.g. agent-kit's headless render has no scrollbar-driven layout shift; a live tab might), without the two shapes silently forking.

---

## CLI Design

```
flowfig init
    Scaffolds flowfig.config.ts, creates .flowfig/ (gitignored contents, tracked dir),
    generates docs/AGENT-GUIDE.md, and offers to append a one-line pointer to the
    project's AGENTS.md if one exists.

flowfig generate [targets...]
    --config <path>          override config file location (default: auto-discover)
    --target <name>          run only this configured target (repeatable)
    --out <dir>               override outDir
    --symbols <path>          override .flowfig/symbols.json location
    --fonts <warn|fail|ignore>  override config's font-failure strategy
    --headed                  debug aid: run non-headless (local dev only, never in CI)
    --json                    machine-readable stdout summary (paths written, warnings) for
                               the calling coding agent to parse instead of human log lines

flowfig guide
    Regenerates docs/AGENT-GUIDE.md only, from the current @flowfig/core convention constants.
    Safe to run in postinstall / on every `flowfig generate` invocation to prevent silent drift
    if the installed agent-kit version bumps its tagging convention.

flowfig doctor
    Runs environment diagnostics (see Sandbox/Footprint Guidance) and prints a pass/fail table
    plus copy-pasteable remediation commands. Exit code non-zero if any hard-required check fails.
    --json                    machine-readable output for the coding agent to branch on

flowfig symbols check
    Validates .flowfig/symbols.json exists and its formatVersion matches what this
    agent-kit build expects; prints age/staleness info.
```

### Config file (`flowfig.config.ts`)

```ts
import { defineConfig } from "@flowfig/agent-kit";

export default defineConfig({
  targets: [
    { name: "landing", url: "http://localhost:3000/", viewport: { width: 1440, height: 900 } },
    { name: "pricing-card", url: "http://localhost:3000/dev/pricing-card", viewport: { width: 800, height: 600 } },
  ],
  symbolsPath: ".flowfig/symbols.json",
  outDir: "flowfig/",
  fonts: {
    // "fail" hard-errors the generate run; "warn" writes the file anyway but flags it;
    // "ignore" suppresses the audit entirely (not recommended — silent mis-measurement).
    strategy: "warn",
  },
  playwright: {
    browser: "chromium",
    launchOptions: {
      args: ["--disable-dev-shm-usage"], // safe default for containerized/sandboxed runs
    },
  },
});
```

Config resolution order: CLI flags > `flowfig.config.{ts,js,mjs,json}` (auto-discovered upward from cwd) > `"flowfig"` key in `package.json` > built-in defaults. TypeScript config files are loaded via on-the-fly transpilation (no build step required in the consuming project), matching convention used by comparable tools (Vite/ESLint-style `defineConfig` + loader).

---

## AGENT-GUIDE.md Content Plan

Written for a coding agent to read *before or while generating markup*, not for a human onboarding to the codebase — so it optimizes for exactness and self-checkability over narrative explanation, per the AGENTS.md-style register found in research (imperative, example-first, terse).

1. **One-paragraph purpose statement** — what this file is for and when the agent should consult it (before writing new UI markup in this repo), so it isn't misread as general project docs.
2. **The four tagging primitives, each with exact syntax and one example** — `data-flowfig-component`, `data-flowfig-new-component`, `data-flowfig-props`, `--ffig-*` custom properties. Exact attribute name spelling matters (typos silently fall back to fuzzy-match); state this consequence explicitly.
3. **Decision table: when to use which primitive** — "reusing an existing design-system component" → `data-flowfig-component` + key from `.flowfig/symbols.json`; "introducing a genuinely new component" → `data-flowfig-new-component` with a PascalCase name; "no tag at all" → explicitly valid, falls back to fuzzy matching, not an error.
4. **Where to get real keys from** — point at `.flowfig/symbols.json`, describe its shape briefly (name → key), and state plainly: *do not invent keys, do not guess names* — an unresolvable key is surfaced to the human rather than guessed, so a wrong tag is a stall, not silent corruption.
5. **Token references** — `var(--ffig-color-accent-500)` style usage, and why it must appear in *authored* CSS, not just as a resolved computed value (computed output loses the reference).
6. **What happens after tagging** — one paragraph: `flowfig generate` renders this code, resolves tags against the symbol table, and writes a translated file for the Figma plugin to import. Gives the agent the "why" in one sentence without turning into a tutorial.
7. **Self-check checklist** — a short bullet list the agent can mechanically verify against its own diff before finishing a task (attribute names spelled exactly, `data-flowfig-props` is valid JSON, new components use PascalCase, etc.).
8. **Explicit non-goals** — hover/focus states, multiple breakpoints, and interactive states are not captured; don't expect tags on those to do anything yet.
9. **Link, not duplicate, environment/sandbox troubleshooting** — a one-line pointer to running `flowfig doctor` if generation fails, rather than reproducing the sandbox guidance (that content lives in `doctor`'s own output and this document, and would rot if copy-pasted into a generated file).
10. **Generation metadata footer** — "generated by agent-kit vX.Y from formatVersion Z, do not hand-edit" plus regeneration command, so an agent doesn't waste effort manually keeping this file in sync.

---

## Sandbox/Footprint Guidance

This is concrete content `flowfig doctor` and the guide's troubleshooting pointer must ship, based on the research above — not generic "install Playwright" advice.

| Symptom | Root cause | What `doctor`/docs must say |
|---|---|---|
| `playwright install` fails with `Error: getaddrinfo EAI_AGAIN storage.googleapis.com` (or `cdn.playwright.dev`) inside an agent sandbox, even with `HTTPS_PROXY` set | Circular DNS-via-proxy: Node's `HttpsProxyAgent` must resolve the proxy's *own* hostname via local DNS first, but the sandbox blocks direct DNS and only permits proxy-mediated lookups | Install the browser during the sandbox's **setup phase**, while network is still open — never lazily at task-run time. If setup-phase install isn't possible, use an **IP-address proxy** (not a hostname), or manually `curl` the exact browser archive from `cdn.playwright.dev` (URL is version-pinned — read it from `node_modules/playwright-core/browsers.json`) into `~/.cache/ms-playwright/` (or `$PLAYWRIGHT_BROWSERS_PATH`), bypassing the built-in downloader entirely. |
| Browser binary present, launch still fails on Linux with missing shared library errors | `install-deps`/OS-level system libraries are **not** part of the cached browser directory and are not covered by caching the binary path | `doctor` must attempt an actual browser *launch* as its check, not just check whether the binary directory exists — presence on disk is necessary but not sufficient. Remediation: `npx playwright install-deps` (or `install --with-deps` the first time). |
| Chromium crashes or renders blank inside a container | Default Docker `/dev/shm` is 64MB, too small for Chromium | Ship `--disable-dev-shm-usage` as a **default** launch arg (already in the proposed config default above), and mention `--shm-size=1gb` as an alternative if the sandbox is a Docker container the agent controls directly. |
| Browser binaries silently missing despite a prior successful CI run | CI cached `node_modules` and ran `npm install` instead of `npm ci`; the cached Playwright package is found on disk and its `postinstall` hook doesn't re-run | `doctor` explicitly checks: does the installed `playwright-core` version match the version string recorded next to the cached browser binaries? If not, it's this exact issue — tell the user to run `npx playwright install` again or switch CI to `npm ci`. |
| A dependency bump changes the Playwright version but the environment's cached browser wasn't re-installed | Version pinning drift between the npm package and the downloaded browser revision | Same check as above, surfaced proactively rather than waiting for a launch failure with an opaque message. |
| Generated file has visibly wrong text width/wrapping vs. the design intent, with no error | A webfont failed to download in a network-restricted sandbox; Playwright silently falls back to a substitute font for layout purposes, and default screenshot-style font-waiting doesn't actually verify success — only that loading *settled* | This is why the driver explicitly checks `document.fonts` entries' `.status` after `document.fonts.ready` resolves (not just awaiting `ready` alone), and why config's `fonts.strategy` defaults to `"warn"`: `generate` must name the specific font-family that failed in its output, not just produce subtly-wrong geometry. Docs must state plainly: if your sandbox blocks the font CDN (Google Fonts etc.), either self-host/vendor the font file so it loads from same-origin, or accept the fallback-metric warning knowingly — don't treat a clean exit code as proof fonts loaded. |
| Someone "fixes" a screenshot hang by setting `PW_TEST_SCREENSHOT_NO_FONTS_READY` | That flag suppresses `page.screenshot()`'s own font-wait, which is the opposite of what layout-accurate measurement needs | Explicitly call this out as the wrong fix for `agent-kit`'s use case in the guide's troubleshooting pointer — the tool doesn't take screenshots for pixels, it depends on real font metrics. |

---

## Phase Task Breakdown (P2)

1. **RFC the snapshot contract** with whoever owns `@flowfig/core`'s resolver input and the extension's content script design — land agreed `SnapshotNode`/`FlowfigSnapshot` types (and ideally the shared `walk-dom` function) in `@flowfig/core` before writing the driver against a private guess.
2. **Scaffold the package**: real `package.json` (bin, `files` allowlist, `exports`), `tsconfig.json` extending the repo base, build via a single-file bundler (esbuild/tsup) producing ESM output for the CLI entry.
3. **Config module**: schema + `defineConfig()` + loader supporting `flowfig.config.{ts,js,mjs,json}` and `package.json` fallback.
4. **Playwright driver**: browser lifecycle with pinned version, safe container launch args by default, navigation + fixed-viewport + scroll-pin, `document.fonts.ready` wait, and the post-ready font-status audit.
5. **Shared DOM walker** integrated via `page.addScriptTag`/`evaluate` (or import from `@flowfig/core` once landed there per task 1).
6. **Symbol table loader**: read `.flowfig/symbols.json`, hard-validate `formatVersion`, typed accessor for the pipeline.
7. **Pipeline glue**: snapshot → `core.resolve()` → `core.translate()` → stamp `formatVersion` → atomic write of `*.translated.flowfig.json`.
8. **CLI wiring** with Commander: `generate`, `init`, `guide`, `doctor`, `symbols check`, shared error/logging formatting, `--json` machine output mode for agent callers.
9. **AGENT-GUIDE.md generator**: template + `convention-constants.ts` (re-exported from core's tag-parser once it exists), snapshot-tested output.
10. **`doctor` diagnostics**: implement each check in the Sandbox/Footprint Guidance table as a discrete, independently testable function; smoke-launch the browser as the definitive "does it actually work" check rather than trusting file presence.
11. **Fixture/integration tests** against `examples/`: static HTML fixtures served locally, snapshot + full pipeline output asserted, cross-checked against whatever the extension side of the same fixtures produces once P3 exists (earlier partial check possible once core lands).
12. **Publish pipeline**: version stamping, `README.md` (human) vs generated `AGENT-GUIDE.md` (agent) kept clearly distinct, explicit decision on whether any Playwright install step runs automatically on `npm install` (see Open Risks — leaning no).

---

## Open Risks / Questions

1. **`@flowfig/core`'s actual resolver/translator signatures are unknown** — this document assumes a `resolve(snapshot) -> resolvedTree` / `translate(resolvedTree, tagInfo, symbolTable) -> translatedFile` shape consistent with the prompt's description, but the real signatures may differ once core is architected. Mitigate by keeping `pipeline/run.ts` as a thin, isolated adapter so a signature change is a one-file fix.
2. **Snapshot contract is genuinely unresolved** cross-package risk, not just an internal detail — if core or the extension lands a shape agent-kit didn't anticipate, the walker needs rework. The RFC-first task ordering above exists specifically to catch this before, not after, the driver is built.
3. **Should `npm install`-time `postinstall` auto-run `playwright install`?** Leaning **no**: an automatic network call during a consuming project's `npm install` is exactly the kind of surprise that breaks in the sandboxes this package targets (per the DNS/proxy finding) and could fail the *host* project's own install. Prefer an explicit `flowfig doctor --install` or documented manual step, surfaced clearly at `init` time. This needs sign-off, not just a default.
4. **Font fallback interface with the plugin is undefined.** `agent-kit` detects and warns about a failed/missing font; the plugin owns the substitute-font mapping table (per the architecture plan's fonts issue). The handoff — does the translated file carry a `fontAudit` block the plugin's Writer consults, or is this purely a build-time human warning with no file-level trace? — needs a decision once both P1 (symbol table format) and this package's translated-file shape are being finalized together.
5. **Determinism across environments.** Headless Chromium can differ subtly (subpixel rounding, font hinting) across OS/versions even with a pinned Playwright version; fixture tests should pin the exact bundled browser revision and may need an explicit float tolerance rather than exact equality.
6. **Repeated-invocation performance in an agent loop.** A coding agent may call `flowfig generate` many times in one session (edit → regenerate → check → repeat); a cold browser launch per invocation may be slow enough to matter. A persistent `flowfig serve`/browser-server mode is a plausible P2-or-later optimization, but adds a process-lifecycle concern this document deliberately does not commit to yet.
7. **`computedStyle` allowlist is a first draft.** The exact property list belongs to whatever `@flowfig/core`'s resolver actually consumes; shipping a wrong/incomplete list is cheap to fix only if the walker is factored so the allowlist is data, not scattered through the extraction code — this constraint should be treated as a design requirement, not an afterthought, in task 5.
