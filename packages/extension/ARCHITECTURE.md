# `@flowfig/extension` — Architecture

Status: planning document for P3. No implementation exists yet — `package.json` is a placeholder. This document is the implementation plan.

---

## Purpose & Scope

`extension` is Producer A in the flowfig pipeline: a Chrome MV3 extension, distributed via the Chrome Web Store, that captures an **arbitrary, already-rendered, live web page** and turns it into a `*.capture.flowfig.json` file. That file is later dropped into the `figma-plugin` package for translation, fuzzy-matching, and writing into a Figma file.

Its whole reason to exist is that it runs *inside* a real tab. It never has to simulate a browser or a cascade engine — `getComputedStyle()` and `getBoundingClientRect()` give it ground truth for free. Concretely, this package:

- Walks the DOM of the active tab (including open shadow roots and same-origin iframes) and reads computed style + geometry per element.
- Hands that raw snapshot to `@flowfig/core`'s `resolve()` for normalization into resolved-but-untranslated tokens/values.
- Calls into `@flowfig/core`'s design-system fuzzy/structural-matching module to produce a v1 baseline of **structural component detection** (repeated card/button/list-item-style patterns), per the resolved decision that widened P3's scope.
- Stamps the current `formatVersion` and writes out `*.capture.flowfig.json` via a user-facing save action.
- Drives the popup/review UI for triggering a capture and previewing results before save.

Explicitly **out of scope** for this package:

- Any cascade/layout engine (the live tab already resolved layout).
- Translation (`core/translator`) — capture files stay untranslated; the plugin translates on import.
- Precision tuning of structural matching (variant detection, cross-page learning, ML-based clustering) — that's P4, building on this package's v1 baseline.
- Multi-viewport or interactive-state capture (hover/focus/breakpoints) — a fixed, stated boundary for the whole system, not just this package.
- Any hosted backend, sync, or account system — nothing here needs one.

---

## Requirements

### Functional

1. Given the user's active tab, capture a raw DOM snapshot (computed style, geometry, structure) of the top-level document and any reachable same-origin iframes/shadow roots.
2. Normalize that snapshot via `@flowfig/core`'s `resolve()` — no duplicate resolution logic invented in this package.
3. Run v1 structural component detection via `@flowfig/core`'s matching module, using data this package is uniquely positioned to supply (live DOM structure, actual class lists).
4. Let the user preview the result (token bindings found, structural clusters detected, unresolved/ambiguous items) before committing to a file.
5. Save the result as `*.capture.flowfig.json`, with `formatVersion` stamped from the same constant `core` uses, so the plugin's hard-reject-on-mismatch policy has a stable target to check against.
6. Work on arbitrary third-party pages the user did not build — no assumption of cooperative markup, no reliance on framework internals.

### Non-functional

1. **Minimal permissions.** No standing `host_permissions`/`<all_urls>`. Capture is a user-initiated, one-tab-at-a-time action — `activeTab` is the correct fit and avoids Chrome Web Store review friction (see Research Findings).
2. **No persistent background footprint.** No content script running on every page load; injection happens on demand, at capture time only.
3. **Resilient to partial failure.** Closed shadow roots and cross-origin iframes are real, unavoidable gaps (see Research Findings) — the tool must degrade gracefully (opaque placeholder) rather than crash or silently drop content.
4. **Small, inspectable output.** Computed style capture must use a curated property allowlist, not all ~300 `CSSStyleDeclaration` properties, to keep files reviewable and payloads bounded.
5. **Alignment with the sibling producer.** The raw snapshot shape must be describable as "generic computed style + geometry + DOM structure," so it stays compatible with what agent-kit/Playwright produces for the same `resolve()` entry point, even though this package has no browser-engine-specific escape hatches Playwright lacks (or vice versa).
6. **Chrome Web Store review readiness.** Permission justifications, privacy policy, and listing metadata prepared as first-class deliverables, not an afterthought, given documented rejection patterns.

---

## Research Findings

### 1. MV3 execution contexts and messaging

Content scripts, the extension service worker, and the popup are three separate execution contexts that cannot share variables or call each other's functions directly — everything crosses via message passing (`chrome.runtime.sendMessage`/`chrome.tabs.sendMessage`, or `chrome.runtime.connect` ports for sustained back-and-forth). The MV3 service worker is non-persistent: it is spun up on demand and torn down when idle, so any state it needs to survive that must live in `chrome.storage`, not module-scope variables. Content scripts share the page's DOM but not its JS scope/`window` — reaching into page-level JS (framework internals, React fiber, etc.) needs `window.postMessage` or a `MAIN`-world injection, but that is *not* needed here: `getComputedStyle()` and `getBoundingClientRect()` are DOM APIs that work fine from the isolated content-script world against DOM node references, with no need to touch page JS scope at all. This directly shapes the design below — no MAIN-world injection is required for the core capture path.

(Sources: developer.chrome.com "Extensions / Manifest V3", extension.js.org "Manifest V3 concepts", multiple 2026 MV3 guides.)

### 2. Shadow DOM traversal

`document.querySelectorAll()` and friends do **not** pierce shadow boundaries — `element.children`/`element.parentElement` stop at the boundary too. To reach into a shadow tree you must manually recurse via `element.shadowRoot`, which exists (and is populated) only for **open** shadow roots; for **closed** roots, `element.shadowRoot` is `null` and there is no supported way in from outside — this is a hard, structural gap, not a bug to work around. There was at least one indication in search results that `getComputedStyle()` behavior against elements physically inside a shadow tree has had edge cases/spec subtleties historically (vs. the generally-expected "works fine once you hold the element reference" behavior) — this is flagged below as something to verify empirically early rather than trust blindly, since the research signal here was not fully clean.

(Sources: MDN "Element: shadowRoot", MDN "ShadowRoot", jsdom issue #3278, Mozilla Bugzilla #1483798, "How to retrieve all shadow roots of a web page.")

### 3. Cross-origin iframes

Extension/content-script access to iframe content is governed by same-origin policy exactly like page JS is — a content script injected into the top frame cannot reach into a cross-origin child iframe's DOM at all. The documented workaround is to *also* inject a content script directly into that iframe (Chrome will do this for same-origin frames, or frames the extension separately has host permission for) and have it `postMessage` data back out; there is no way to reach a cross-origin iframe the extension has no permission for. Since this package deliberately avoids broad `host_permissions`, cross-origin third-party iframes (ads, embedded widgets, payment/video embeds) will not be capturable beyond their outer bounding box.

(Sources: Chromium issue tracker #41090046, chromium-extensions mailing list, "Chrome Extension: handle request with CORS restriction.")

### 4. Saving files from an MV3 extension

`chrome.downloads.download()` is the robust path from a service worker but requires the `"downloads"` permission and — notably — `URL.createObjectURL()` for blobs is not usable from a service worker in MV3, complicating a downloads-API-only approach. The simpler, permission-free path: any extension **page** with a DOM (popup, or a full extension tab) can build a `Blob`, call `URL.createObjectURL()`, and trigger a save via a temporary `<a download>` click — this needs zero extra manifest permissions. This is a strong permission-minimization finding: it directly avoids adding `"downloads"` to the manifest at all.

(Sources: codestudy.net "How to Save Files to Disk in a Chrome Extension," chromium-extensions mailing list thread on `chrome.downloads.download`.)

### 5. Prior art — html.to.design

html.to.design's Chrome extension (companion to its Figma plugin) follows exactly the file-handoff shape this monorepo already commits to: the user opens a page, clicks the extension, it captures the page, and produces a file (`.h2d`) that's either dropped into the Figma plugin or sent over via "Send to Figma plugin." This validates the two-stage "capture extension → separate Figma-side import" pattern architecturally, independent of flowfig's own design. It doesn't publish its internal DOM-clustering algorithm, so no algorithmic detail was reusable from it directly — the structural-matching approach below is derived from general DOM-similarity-detection literature instead (next point).

(Sources: html.to.design Chrome Web Store listing, html.to.design docs "Import directly from your browser with the browser extension.")

### 6. Structural/repeated-pattern detection literature

General DOM-clustering research (patent literature on clustering repetitive async web-app content, and academic work on "Flexible Detection of Similar DOM Elements") converges on: compute a structural signature per node (tag, structural shape of children, sometimes hashed via something like LSH) independent of exact text/position, then group siblings/cousins whose signatures match or are within a distance threshold. Simpler variants use plain structural-signature equality; more advanced ones combine location + inner structure + wrapper-induction techniques and need labeled data to tune thresholds. This informs the v1 vs. P4 split below: v1 takes the simple equality-signature approach (cheap, explainable, few false positives); the distance-threshold/fuzzy variant is the natural P4 upgrade.

(Sources: USPTO patent "Clustering repetitive structure of asynchronous web application content," ResearchGate "A Scoring Map Algorithm for Automatically Detecting Structural Similarity of DOM Elements," "Flexible Detection of Similar DOM Elements" — Springer.)

### 7. Chrome Web Store review

Typical review is fast (a large majority within ~3 days) but 2026 search results explicitly note a submission surge extending timelines in some periods — budget slack, don't assume review is instant the way `npm publish` is (this echoes the architecture plan's own "Foreseeable issue #1" about npm-vs-reviewed-store skew). The most common rejection causes are: excessive/unjustified permissions, missing privacy policy, incomplete store listing (screenshots/description), obfuscated code, and undisclosed remote code execution (the latter two are zero-tolerance auto-reject triggers). Google explicitly requires a short justification per sensitive permission, and requesting `<all_urls>`/broad `host_permissions` for functionality that doesn't need standing access "will almost certainly trigger manual review and likely get rejected." `activeTab` is called out specifically as the preferred alternative when the extension only needs the page the user is currently, explicitly acting on — it shows no install-time warning and needs no justification essay.

(Sources: developer.chrome.com "Chrome Web Store review process," developer.chrome.com "Declare permissions," extensionbooster.net "Chrome Extension Permissions: Request Less, Get More Installs," "Chrome Web Store Extension Review Time 2026.")

---

## Proposed Architecture

### Module layout

```
packages/extension/
├── manifest.json
├── package.json
├── tsconfig.json                 # extends ../../tsconfig.base.json
├── src/
│   ├── collector/                # injected on demand; pure DOM-walking, no @flowfig/core bundled here
│   │   ├── walk-dom.ts           # main recursive walker
│   │   ├── shadow-dom.ts         # open-shadow-root recursion helpers
│   │   ├── frames.ts             # same-origin iframe detection/recursion, cross-origin placeholder logic
│   │   ├── computed-style-allowlist.ts   # curated property list (vendored copy — see DOM Snapshot Contract)
│   │   └── index.ts              # entry point: the function handed to chrome.scripting.executeScript
│   ├── background/
│   │   └── service-worker.ts     # onInstalled defaults; optional contextMenus listener (stretch)
│   ├── popup/
│   │   ├── index.html
│   │   ├── popup.ts              # "Capture this page" trigger only; opens the review tab
│   │   └── popup.css
│   ├── review/                   # dedicated extension tab — the actual capture/resolve/save workspace
│   │   ├── review.html
│   │   ├── review.ts             # calls collector, then @flowfig/core resolve() + structural match, preview, save
│   │   └── review.css
│   ├── lib/
│   │   ├── messaging.ts          # typed message/constant helpers
│   │   ├── storage.ts            # chrome.storage.local wrappers (small settings only)
│   │   └── file-save.ts          # Blob + <a download> helper (no "downloads" permission)
│   └── shared/
│       └── snapshot-types.ts     # RawDomSnapshot contract — see below
├── public/icons/{16,48,128}.png
└── vite.config.ts                # or esbuild multi-entry; TBD at implementation time, not decided here
```

### Why a popup *and* a dedicated review tab

The popup UI in MV3 is transient — it is torn down the instant it loses focus. A capture-and-resolve pass (DOM walk + `resolve()` + structural matching) on a large/complex page is exactly the kind of multi-hundred-millisecond-to-few-seconds async work that must not live in a context that can vanish mid-flight. So responsibilities split:

- **Popup**: razor-thin. Shows the current tab, one "Capture this page" button, and opens the review tab (`chrome.tabs.create`) passing the source `tabId`. It does not itself call `resolve()` or hold the snapshot.
- **Review tab**: a full extension page (`chrome-extension://.../review.html?tabId=…`) with a normal page lifetime. On load, it calls `chrome.scripting.executeScript({ target: { tabId }, func: collectorEntry })` to run the collector against the *original* tab, receives the raw snapshot back as the executeScript call's return value (no separate message-passing plumbing needed for the bulk payload), then bundles and calls `@flowfig/core`'s `resolve()` and structural-matching module, renders a preview, and only then triggers the file save.
- **Service worker**: minimal. `chrome.runtime.onInstalled` to seed default settings in `chrome.storage.local`. Optionally hosts a `chrome.contextMenus` "Capture with Flowfig" entry as an alternate entry point (stretch — needs the `contextMenus` permission and a background listener, since context-menu clicks fire in the background context, not the popup). No capture logic ever runs here.

### Message-passing flow

```
1. User clicks the toolbar icon on some arbitrary live page.
   → Chrome grants activeTab for this tab; popup.html opens.
2. Popup: user clicks "Capture this page."
   → popup.ts calls chrome.tabs.create({ url: review.html?tabId=<id> })
3. Review tab loads (its own page lifetime; popup can now safely close).
   → review.ts calls chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectorEntry })
4. Collector (injected into the tab's isolated world, and into each
   same-origin frame reachable via allFrames) walks the DOM:
     - recurses through element.shadowRoot for open shadow roots
     - recurses into same-origin iframe documents
     - marks closed shadow roots / cross-origin iframes as opaque placeholders
     - reads getComputedStyle() + getBoundingClientRect() per element
   → returns a RawDomSnapshot (per-frame results merged) as the
     executeScript call's structured-clone return value.
5. Review tab: calls @flowfig/core resolve(snapshot) → resolved tree.
   Then calls core's structural-matching module with the resolved tree
   plus extension-computed structural signatures → detectedComponents.
6. Review tab renders a preview: token bindings found/unresolved,
   detected structural clusters, any opaque-placeholder warnings.
7. User clicks "Save." → file-save.ts builds a Blob of the final
   *.capture.flowfig.json (formatVersion stamped), creates a temporary
   <a download> element, clicks it. No "downloads" permission needed.
```

No custom message-passing protocol is needed for the bulk snapshot payload at all — `chrome.scripting.executeScript`'s own return-value channel carries it. `chrome.storage` is reserved for small things only (user settings such as "always open review tab in a new window" or a short capture history), never for the snapshot itself.

---

## DOM Snapshot Contract

This is what the collector hands to `@flowfig/core`'s `resolve()`. Since `core` is being architected in parallel and its final types aren't visible yet, this section defines an interim, explicitly-versioned local contract, plus the plan for reconciling it once `core` lands.

```ts
// src/shared/snapshot-types.ts — interim, vendored copy.
// TODO(P3): replace with the real type import once @flowfig/core publishes
// its resolver input types; add a fixture-based conformance test at that point.

interface RawDomSnapshot {
  source: {
    url: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
    userAgent: string;
    capturedAt: string; // ISO 8601
  };
  root: RawDomNode;
}

interface RawDomNode {
  nodeId: string;                          // synthetic, path-based, stable within this capture only
  tagName: string;                         // lowercase, or "#text" / "#shadow-root"
  attributes: Record<string, string>;
  classList: string[];
  textContent?: string;                    // leaf text only; trimmed and length-capped
  computedStyle: Record<string, string>;   // curated allowlist — see below, NOT all ~300 CSSOM props
  rect: { x: number; y: number; width: number; height: number; top: number; left: number };
  shadow?: { mode: 'open' | 'closed-opaque' };
  frame?: { origin: 'same-origin' | 'cross-origin-opaque'; src: string };
  children: RawDomNode[];
}
```

Design choices and how alignment with agent-kit/Playwright is kept without seeing `core`'s real types:

- **No Chrome-specific types leak into the shape.** `computedStyle` is a plain `Record<string,string>`, not a `CSSStyleDeclaration`; `rect` is a plain object, not a `DOMRect`. Playwright can produce the exact same plain-object shape via `page.evaluate()` against the exact same allowlist, and Playwright has direct equivalents for both annotations here (`frame` objects for iframes, and shadow-DOM piercing via `elementHandle.evaluate`).
- **The computed-style property allowlist is treated as `core`'s property, not this package's**, since `core`'s resolver is what actually interprets those values into tokens. Until `core` exports a real constant, this package vendors a local, clearly-TODO-marked copy (`computed-style-allowlist.ts`) covering the layout/spacing/typography/color properties both producers plausibly need, and a P3 task (below) is dedicated to reconciling it against `core`'s real list the moment it exists.
- **Structural annotations (`shadow`, `frame`) are additive metadata, not core-DOM fields**, so they degrade to "absent" harmlessly for a Playwright-produced snapshot that has no shadow/iframe content to report, or reports it differently.
- **A fixture pair lives in `examples/`** (per the monorepo's existing shared-fixtures directory) — a sample raw snapshot produced by this package's collector against a small fixture page, checked in so agent-kit's Playwright-based producer can be tested against structurally the same shape without the two packages needing to import each other.
- The real reconciliation point is a task in the breakdown below: once `core` ships its resolver input types, add a contract/conformance test that validates `RawDomSnapshot` (or whatever this package emits) against `core`'s actual expected input, and delete the local vendored copy in favor of importing the real one.

---

## Structural Matching v1 Approach

Per the resolved decision, P3 (this package) must ship a **baseline** heuristic — not full precision-tuned matching, which is P4. Division of responsibility, respecting that this package must not invent a competing implementation of what belongs in `core`:

- **This package's job**: because it alone has the live, actual DOM (real class lists, real markup depth, real repetition), it computes a **structural signature per node** and hands the annotated tree to `core`'s matching module. It does not itself decide what counts as "the same component" — that clustering logic is `core`'s, so it can eventually be shared with agent-kit's fallback fuzzy-matching path too.
- **Signature computed per node** (v1, cheap and explainable):
  - Tag name.
  - A **normalized** class list — hashed/generated suffixes stripped via a regex heuristic (e.g., CSS-modules `_a8f3c1`-style hashes, styled-components `sc-xxxxx` classes), so two structurally-identical components with different build-generated class hashes still normalize to the same signature. Meaningful utility classes (Tailwind-style) are kept as-is.
  - The tag-name sequence of immediate children (shape of the subtree one level down), not full recursive content — deliberately shallow for v1.
  - Depth in the tree, to avoid clustering superficially-similar nodes that sit at very different structural positions.
- **Clustering rule for v1: exact signature equality only**, among siblings/cousins under a shared ancestor. No edit-distance/fuzzy threshold in v1 — that is explicitly the P4 upgrade (the literature reviewed uses distance thresholds and wrapper-induction for that precision tier; v1 intentionally skips it to keep false positives low and behavior explainable).
- **Confidence signal**: a coarse count-based score (e.g., 3+ identical-signature instances → high confidence "this is a repeated component"; exactly 2 → medium; flagged but not auto-labeled for 1). No ML/visual-similarity signal in v1.
- **Output**: clusters are embedded into the outgoing capture JSON as metadata alongside the resolved tree (e.g., a `detectedComponentGroupId`/`detectedComponentName` per matched node) — **not** written back as `data-flowfig-*` attributes onto the live page's DOM. This keeps the extension from ever mutating a third-party page. The plugin's Node Writer treats these as a lower-confidence signal than a real `data-flowfig-component` tag or an exact fuzzy-match, but a stronger starting point than nothing.

**Explicitly deferred to P4** (do not attempt in this package):
- Fuzzy/distance-based clustering (near-but-not-identical structural matches).
- Variant/prop inference (e.g., recognizing "same Card, different image/props" rather than only "identical markup").
- Cross-page or cross-capture learning (remembering patterns from a previous capture).
- Any ML-embedding or rendered-pixel visual-similarity signal.
- Interactive-state-aware pattern detection.

The review-tab UI should say so explicitly to the user (e.g., "Detected structure is a first-pass heuristic — review before relying on it"), since exact-signature clustering will predictably both over-cluster (two visually distinct but structurally identical icon buttons) and under-cluster (two visually-identical cards where one has an extra optional badge `div`). That's an accepted, stated v1 tradeoff, not a bug.

---

## Permissions & Manifest

```json
{
  "manifest_version": 3,
  "name": "Flowfig Capture",
  "version": "0.1.0",
  "description": "Capture a live web page's rendered styles and structure into a Flowfig file for import into Figma.",
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" },
  "action": {
    "default_popup": "popup/index.html",
    "default_icon": { "16": "icons/16.png", "48": "icons/48.png" }
  },
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "permissions": ["activeTab", "scripting", "storage"],
  "optional_permissions": ["contextMenus"],
  "minimum_chrome_version": "116"
}
```

Deliberately **absent**, and why:

- **No `host_permissions` / `<all_urls>`.** Capture is always a single, explicit, user-initiated action on the tab currently in front of them — the textbook case `activeTab` exists for. Research is explicit that requesting broad host permissions for functionality that only needs the current tab is a top rejection trigger and a trust cost with no offsetting benefit here.
- **No static `content_scripts` entry in the manifest.** The collector is injected programmatically via `chrome.scripting.executeScript` at capture time (hence the `"scripting"` permission), not declared to run automatically on every navigation. This means the extension has zero standing footprint on pages the user hasn't explicitly asked it to look at.
- **No `"downloads"` permission.** File save happens via `Blob` + `URL.createObjectURL()` + `<a download>` inside the review tab (a normal extension page with a DOM), per the research finding above — the `chrome.downloads` API and its permission are unnecessary for this flow.
- **`"storage"`** is kept for small settings only (never the capture payload itself).
- **`"contextMenus"` is optional**, requested only if/when the stretch alternate-entry-point ships, and can be requested at runtime via `chrome.permissions.request` rather than baked into the required set.

This permission set should need no special "sensitive permission" justification essay beyond the store listing's normal description, which keeps first-submission review friction low.

---

## Phase Task Breakdown (P3)

1. **Scaffold**: real `package.json` (workspace dep on `@flowfig/core`, TS, bundler choice — Vite+CRXJS or esbuild multi-entry, decided at implementation start), `tsconfig.json` extending `tsconfig.base.json`, `manifest.json` as above, icon set, a build producing a loadable `dist/` for `chrome://extensions` "Load unpacked."
2. **Collector core**: `walk-dom.ts`, `shadow-dom.ts` (open-root recursion), `frames.ts` (same-origin recursion + cross-origin placeholder), computed-style allowlist capture, rect capture. Unit-testable in isolation (jsdom for structure-only cases) but **must also get a real-browser smoke test** (see task 7) since jsdom cannot validate real shadow-DOM/`getComputedStyle` fidelity.
3. **Popup**: thin trigger UI — current tab display, "Capture this page" button, opens the review tab with `tabId`.
4. **Review tab shell**: routing by `tabId` query param, calls `chrome.scripting.executeScript` against the collector, error/loading states (including explicit surfacing of any opaque-placeholder shadow/iframe warnings).
5. **`@flowfig/core` integration**: bundle and call `resolve()` on the raw snapshot; render token-binding preview.
6. **Structural matching v1**: implement signature computation (tag/normalized-class/child-shape/depth) in the collector or review tab, call `core`'s matching module, embed `detectedComponents` metadata into the preview and output.
7. **File save + formatVersion stamping**: `Blob`/`<a download>` helper; pull the canonical `formatVersion` constant from `core` and stamp every output file with it.
8. **Real-browser integration test**: load the unpacked extension via Playwright's persistent-context support, drive popup → review tab → save, assert output against fixtures in `examples/`. This is also the moment to empirically verify the two flagged research uncertainties (shadow-DOM `getComputedStyle` fidelity; whether `activeTab`'s grant is usable from a separately-opened review tab, not just the popup) rather than trusting search-result summaries.
9. **`core` contract reconciliation**: once `@flowfig/core` publishes its real resolver input types and computed-style allowlist, replace the vendored `snapshot-types.ts`/`computed-style-allowlist.ts` copies with real imports; add the conformance test described in the DOM Snapshot Contract section.
10. **Chrome Web Store submission prep**: privacy policy, permission-justification copy (should be trivial given the minimal permission set), listing screenshots/description, manual pre-submission checklist against the documented common-rejection list (obfuscation, undisclosed remote code, broken functionality).
11. **Submit**; budget calendar slack for review (days typically, but treat as "not instant" given the noted 2026 submission surge) — this is the same npm-vs-reviewed-store skew the architecture plan already calls out as a foreseeable issue for the sibling `figma-plugin` package.
12. **Stretch, not required for P3 exit**: optional `contextMenus` alternate entry point; element-picker capture mode (capture a sub-tree instead of the whole page).

---

## Open Risks / Questions

1. **Closed shadow roots are genuinely inaccessible.** `element.shadowRoot` is `null` for closed roots from outside; there is no supported way in. Any component library using closed mode will show as an opaque leaf in captures. This is a hard scope boundary to communicate to users, not a bug to chase.
2. **Cross-origin iframes cannot be captured beyond their outer bounding box**, since this package deliberately does not request the broad host permissions that would be needed to inject into arbitrary third-party iframe origins. Ads, payment widgets, and video embeds will appear as opaque placeholders. Needs to be surfaced clearly in the review-tab UI so users aren't surprised by a "missing" embedded widget.
3. **`getComputedStyle()` fidelity inside shadow trees** had a not-fully-clean research signal (one source suggested correctness caveats vs. the generally-expected "works once you hold the element reference" behavior). Task 8 above calls out empirical verification early rather than trusting this blind — if it turns out to be a real problem, it could reshape the collector's shadow-DOM handling meaningfully.
4. **Whether an `activeTab` grant is usable by a review tab opened via `chrome.tabs.create`, separate from the popup that received the grant**, is assumed but not yet verified against current Chrome behavior. If it turns out the grant doesn't carry over, the fallback is either (a) do the whole capture pipeline inside the popup itself (reintroducing the popup-lifetime risk this design specifically avoided), or (b) request broader standing permissions (reintroducing Chrome Web Store review friction). This should be a first-week spike, not something discovered late.
5. **`chrome.scripting.executeScript`'s return-value channel has a soft/undocumented size ceiling** for very large or deeply-nested pages (e.g., data-dense dashboards). Typical marketing/landing pages should be fine; if this bites in practice, the return-value approach may need to become a chunked/streamed message-passing protocol instead — flagged as a possible redesign trigger, not assumed away.
6. **Chrome Web Store review timeline volatility.** Even with a clean, minimal-permission manifest, 2026 search results note submission surges extending typical review windows — don't schedule P3's ship date assuming the fast case.
7. **Structural-matching v1's exact-signature clustering will both over- and under-cluster** by design (stated tradeoff above) — worth confirming with whoever owns `core`'s matching module that the "additive metadata, non-blocking" embedding approach here is exactly what the plugin's Node Writer expects to consume, since this package is downstream of a module it doesn't own the design of.
8. **The computed-style property allowlist and `resolve()`/matching-module exact signatures are unknown until `core` lands.** This package's tasks 2–6 proceed against a locally vendored, clearly-TODO-marked stub; task 9 is the explicit reconciliation point. Coordinate directly with whoever is building `core` before finalizing task 2, since the allowlist shape affects the entire collector.
