# `@flowfig/core` — Architecture

Status: planning document for P0. No implementation exists yet; this defines the contract everything else in the monorepo will be built against.

---

## Purpose & Scope

`core` is the private, never-published library shared by `figma-plugin`, `extension`, and `agent-kit`. It owns four things and nothing else: the flowfig JSON **format** (types + validation), the **resolver** (raw DOM/style snapshot → normalized resolved-node tree), the **translator** (resolved tree + tags + symbol table → componentRef/token-annotated tree), and **design-system matching** (fuzzy value/color/spacing matching plus structural component matching, shared by plugin and extension).

`core` is explicitly *not*: a place for `figma.*` calls, `chrome.*` calls, Node-only APIs (`fs`, `path`, Playwright itself), or any I/O. Every exported function in `resolver/`, `translator/`, `matching/`, and `format/` must be a pure function over plain data — that purity is what makes P0 verifiable with zero browser and zero Figma runtime, and it's what lets three different bundlers (Figma plugin sandbox, Node CLI, MV3 extension) each compile the same source for their own target without `core` ever needing to guess which one is calling it.

---

## Requirements

### Functional

- **format**: define `formatVersion`-tagged types for all three file kinds (`*.capture.flowfig.json`, `*.translated.flowfig.json`, `.flowfig/symbols.json`); provide runtime validators that hard-reject a `formatVersion` mismatch (no migration shims, per resolved decision) and hard-reject structurally malformed files with a specific, actionable error.
- **resolver**: normalize a raw computed-style + geometry + DOM-structure snapshot — producible identically by a live Chrome tab and by Playwright — into one resolved node tree. Must infer Figma-auto-layout-shaped layout data (axis, sizing modes, alignment, spacing, padding) from CSS flexbox/grid/static layout, since the Node Writer (built in P1) needs to consume this without the schema being redesigned later.
- **translator**: consume a resolved tree + `data-flowfig-*` tag attributes + a symbol table, and produce a translated tree carrying `componentRef` (existing-by-key or new-component) annotations and CSS-custom-property token refs (`--ffig-*`) resolved to symbol-table variable ids. Must degrade gracefully per-element: untagged/untokened nodes pass through unannotated (tagging is not all-or-nothing, per resolved decision) and fall back to the matching module.
- **matching**: fuzzy value matching (color, spacing) against a symbol table's variables/styles, in two modes — value-only (used by translator's fallback path and figma-plugin's Node Writer) and value+structural (used by the extension's v1 component detection, and later the plugin). Structural matching must be expressible as a pure comparison over an abstract signature, not over live Figma or live DOM nodes directly, since `core` cannot depend on either.
- All four modules must be independently unit-testable with hand-authored JSON fixtures — no network, no browser, no Figma plugin runtime.

### Non-functional

- **TS strict mode**, shipped as raw `.ts` source (see "raw TS" decision below) — no compiled `dist/`.
- **Zero runtime dependency on `figma`, `chrome.*`, or Node built-ins** anywhere in `format/`, `resolver/`, `translator/`, `matching/`. This is the actual guarantee that keeps the package usable from all three consumer runtimes; it should be enforced by lint rule (e.g. `no-restricted-globals`/`no-restricted-imports` for `figma`, `chrome`, `node:*`) as an early P0 task, not left to convention.
- **Minimal npm dependencies.** Every dependency `core` takes is a dependency all three downstream bundlers must resolve and bundle, including the Figma plugin sandbox, which has real code-size constraints. Prefer hand-rolled implementations (validation, color math) over pulling in `zod`, `culori`, etc., unless a hand-rolled version becomes a correctness or maintenance risk — see Open Risks.
- **Deterministic.** Same input snapshot → byte-identical resolved/translated tree (JSON key order aside), which is what makes golden-file fixture testing possible at all.
- **No dependency on wall-clock time or randomness** inside pure functions — timestamps belong to the file wrapper (produced by the caller), not to `resolve()`/`translate()`/`match*()` themselves.

---

## Research Findings

### 1. Figma Plugin API — node shape, auto-layout, variables, components

Searched: "figma plugin api node types", "figma plugin api auto layout properties", "figma plugin api variables API", "figma plugin api component instance API" (developers.figma.com/docs/plugins).

- `SceneNode` is a large discriminated union (`FrameNode`, `TextNode`, `RectangleNode`, `VectorNode`, `ComponentNode`, `InstanceNode`, `GroupNode`, …). For flowfig's v1 surface (frames, text, images, inline vectors, component instances), only four target shapes matter — this is why `ResolvedNode.kind` below is a 4-member union, not an attempt to mirror all of Figma's node types.
- Auto-layout ([layoutMode docs](https://developers.figma.com/docs/plugins/api/properties/nodes-layoutmode/)): `layoutMode` is `"NONE" | "HORIZONTAL" | "VERTICAL"`; when non-`NONE`, `primaryAxisSizingMode`/`counterAxisSizingMode` are `"FIXED" | "AUTO"` ("AUTO" = hug contents), `primaryAxisAlignItems`/`counterAxisAlignItems` control justify/align, `itemSpacing`/`counterAxisSpacing` are the gap, and `paddingTop/Right/Bottom/Left` are explicit per-side numbers — no shorthand. This maps closely enough to CSS flex properties that the resolver's `AutoLayout` type (below) is deliberately shaped to be a near-1:1 pre-image of these fields, so the future Node Writer is mostly an assignment pass, not a translation pass.
- Per-child sizing: modern Figma API exposes `layoutSizingHorizontal`/`layoutSizingVertical` as `"FIXED" | "HUG" | "FILL"` directly on a child of an auto-layout frame — a cleaner mental model than the older `layoutGrow`/`layoutAlign` pair. The resolver targets this newer three-state model (`sizing.horizontal`/`sizing.vertical`) since it's a strictly more direct match for `width: auto` (HUG), `width: 100%`/`flex: 1` (FILL), and `width: <px>` (FIXED).
- Variables ([Working with Variables](https://developers.figma.com/docs/plugins/working-with-variables/)): four `resolvedType`s — `BOOLEAN | FLOAT | STRING | COLOR` — living in a `VariableCollection`, bound to node fields via `setBoundVariable`. This is exactly the shape `SymbolVariableEntry.resolvedType` mirrors, so a `--ffig-*` token ref can be bound later without a lossy re-typing step.
- Components ([ComponentProperties docs](https://developers.figma.com/docs/plugins/api/ComponentProperties/)): an instance's `mainComponent` plus `componentPropertyDefinitions` (variant/boolean/text/instance-swap properties, the latter three suffixed `#<id>`) is the full shape a `data-flowfig-props` payload needs to be checked against at write time. `core` doesn't call this API, but `SymbolComponentEntry.variantProperties` is shaped to hold what the P1 scraper will read from it.

### 2. `getComputedStyle()` vs. Playwright's `page.evaluate()`

Searched: "getComputedStyle vs Playwright page.evaluate style extraction differences units shorthand".

The important finding: **Playwright doesn't have its own style/layout engine** — `page.evaluate(() => getComputedStyle(el))` runs literally inside real Chromium (or Firefox/WebKit), so it calls the exact same browser API the extension's content script calls. This means the resolver does **not** need to reconcile two different computed-style semantics — both producers hand it strings/numbers straight out of the CSSOM. What actually differs between the two producers is *environment*, not *API*:

- **Font availability.** Playwright's bundled Chromium may lack system/webfont fallbacks that a real user's Chrome has installed, and vice versa — a documented issue already called out in the architecture plan's "Fonts, twice over." The resolver should not assume text metrics are pixel-identical across producers; the translated/resolved schema keeps `fontFamily` as a name, never a baked metric.
- **Viewport/DPR control.** The extension observes whatever real viewport/DPR the user's tab happens to have; agent-kit fixes both deliberately. `RawDomSnapshot.viewport` is therefore a required field, not inferred.
- **Declared vs. computed values, and the token problem.** This is the finding that actually shapes the schema. `getComputedStyle()` only ever returns *used values* — `background: var(--ffig-color-accent-500)` resolves to `rgb(...)`, and the `var()` reference is gone. The architecture plan is explicit that token detection must survive cascade by reading *declared* CSS, not computed output. Both producers, however, do have access to the declared rule text through the same API: `document.styleSheets` (CSSOM) is available identically in a content-script context and in a Playwright `page.evaluate()` context — so this is legitimately something a single shared contract can specify, not something that has to differ per-producer. The Resolver Input Contract (below) therefore carries an explicit, separate `declaredDeclarations` side-channel per node, distinct from `computedStyle`.
- **Shorthand.** Both engines expose the same longhands through `getComputedStyle` (e.g., `margin-top`, not a combined `margin` shorthand, for most box properties) — so no cross-producer shorthand-expansion mismatch exists either. `line-height` is always resolved to a `px` value by both, even when authored as a unitless multiplier — one less normalization case for the resolver.
- **Pseudo-elements.** `getComputedStyle(el, '::before'|'::after')` works identically in both contexts. v1's scope boundary (per the architecture plan: one DOM state, no hover/focus/transitions) means the resolver does not walk pseudo-elements in P0 — noted as a fixed-viewport-only limitation, not solved here.

### 3. Prior art — CSS → Figma auto-layout mapping

Searched and inspected source for `mike2151/html-to-figma` (GitHub), `BuilderIO/figma-html`, and `gridaco/designto-code`'s auto-layout doc.

- `mike2151/html-to-figma`'s actual converter ([html-to-figma-converter.ts](https://github.com/mike2151/html-to-figma/blob/main/plugin/src/html-to-figma-converter.ts)) is a cautionary example rather than a pattern to copy: it does regex-based CSS parsing (no cascade, no specificity), never sets `layoutMode` at all, and lays out children with a hardcoded `yOffset += 30` "simple flow layout." It validates, by counter-example, the architecture plan's decision to make Playwright a hard dependency rather than attempting static-parse-only layout — a naive parser genuinely cannot recover real flex/grid geometry, box-sizing, or intrinsic sizing.
- `gridaco/designto-code`'s [figma-autolayout.md](https://github.com/gridaco/designto-code/blob/main/docs/figma-autolayout.md) documents the mapping this package should follow: `layoutMode` ↔ `flex-direction`, `primaryAxisAlignItems` ↔ `justify-content`, `counterAxisAlignItems` ↔ `align-items`, sizing modes ↔ intrinsic vs. fixed sizing. Its most useful caveat: **stretch cannot be inferred from a container's own properties alone** — CSS `align-items: stretch` behavior on the cross axis has to be read off whether children actually have an explicit cross-axis size; if none does, treat the container's cross-axis sizing as `AUTO`, else `FIXED`+child `FILL`. The resolver's sizing inference (`sizing.ts`) implements this two-pass approach (children first, then container) explicitly rather than trying to infer bottom-up from computed style tokens alone.
- Neither project documents CSS Grid → Figma mapping in any real depth, and Figma's auto-layout has no native two-dimensional-grid primitive. **Decision for P0: Grid containers resolve as `layoutMode: "NONE"` with children carrying absolute geometry** (same fallback as arbitrary `position` layouts) — a faithful-but-flat capture rather than a lossy attempt to fake grid with nested auto-layout frames. Grid-aware auto-layout is flagged as a P4/P5-era enhancement, not a P0 blocker (see Open Risks).

### 4. Design-token fuzzy matching — color distance

Searched: "design token fuzzy matching color distance Delta E nearest neighbor implementation".

- **CIEDE2000** is the industry-standard perceptual color-difference metric; **CIE76** (plain Euclidean distance in CIELAB space) is the simpler, still widely-used default when exact perceptual accuracy isn't required. Reference thresholds found: ΔE ≤ 1.0 is indistinguishable to the human eye, ≤ 2.0 is "barely noticeable," 2–10 is clearly noticeable, and >10 is a different color outright.
- **Decision for P0:** implement sRGB → CIELAB conversion and **CIE76** distance by hand (a few dozen lines, zero dependency) rather than pulling in a color library, and use ΔE thresholds of **≈0.5 → "exact"** (accounts for float/rounding noise from the two capture paths) and **≤2.0 → "close match"** as the default `colorDeltaEThreshold`. Upgrading to CIEDE2000 is a natural, isolated P4 "fuzzy-match tuning" swap (the roadmap already reserves P4 for exactly this) — `matchColor`'s signature doesn't need to change to make that swap later.
- No equally standardized metric exists for *spacing* fuzzy-matching; nearest-neighbor on raw pixel distance against the symbol table's numeric spacing/radius variables, with a tolerance in px, is the pragmatic default (`matchSpacing` below) and is consistent with how color matching degrades (exact / close / none).

---

## Proposed Architecture

```
packages/core/
├── package.json
├── tsconfig.json                 # extends ../../tsconfig.base.json
├── ARCHITECTURE.md               # this file
└── src/
    ├── index.ts                  # public barrel: re-exports format/resolver/translator/matching
    ├── format/
    │   ├── index.ts
    │   ├── types.ts              # ResolvedNode, RgbColor, geometry, the 3 file-kind wrappers
    │   ├── validate.ts           # parseCaptureFile / parseTranslatedFile / parseSymbolTableFile / assertFormatVersion
    │   └── errors.ts             # FormatVersionMismatchError, SchemaValidationError
    ├── resolver/
    │   ├── index.ts
    │   ├── types.ts              # RawDomSnapshot(Node), ResolvedTree — THE linchpin contract
    │   ├── resolve.ts            # resolve(): tree walk, orchestrates layout/sizing/text
    │   ├── layout.ts             # computedStyle subset -> AutoLayout | null
    │   ├── sizing.ts             # HUG / FILL / FIXED two-pass inference
    │   ├── color.ts              # CSS color-string parsing -> RgbColor (shared w/ matching)
    │   └── text.ts               # font/line-height/letter-spacing normalization
    ├── translator/
    │   ├── index.ts
    │   ├── types.ts              # SymbolTable*, TranslateInput, TranslatedNode, ComponentRef
    │   ├── translate.ts          # translate()
    │   ├── tags.ts               # data-flowfig-* attribute parsing -> ComponentTagIndex
    │   └── tokens.ts             # declaredDeclarations -> --ffig-* refs -> SymbolVariableEntry
    ├── matching/
    │   ├── index.ts
    │   ├── types.ts              # MatchMode, MatchOptions, *MatchResult, StructuralSignature
    │   ├── color.ts               # lab conversion + deltaE76 + matchColor
    │   ├── spacing.ts             # matchSpacing
    │   └── structural.ts          # computeStructuralSignature (ResolvedNode-side) + structuralSimilarity
    └── testing/
        └── fixtures.ts           # loadFixture(caseName) — reads json from ../../../examples/<case>/
```

`examples/` (already scaffolded at repo root) stays outside `packages/core/`, shared with the other three packages — see Fixture/Testing Strategy.

### `format/`

```ts
// format/types.ts

export const FORMAT_VERSION = 1 as const;
export type FormatVersion = typeof FORMAT_VERSION;

export type NodeKind = "FRAME" | "TEXT" | "IMAGE" | "VECTOR";

export interface RgbColor {
  r: number; // 0..1
  g: number; // 0..1
  b: number; // 0..1
  a: number; // 0..1, 1 = opaque
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Axis = "HORIZONTAL" | "VERTICAL";
export type AxisSizingMode = "FIXED" | "AUTO"; // AUTO = hug contents
export type ChildSizingMode = "FIXED" | "HUG" | "FILL";
export type PrimaryAxisAlign = "MIN" | "MAX" | "CENTER" | "SPACE_BETWEEN";
export type CounterAxisAlign = "MIN" | "MAX" | "CENTER" | "BASELINE";

export interface AutoLayout {
  axis: Axis;
  primaryAxisSizingMode: AxisSizingMode;
  counterAxisSizingMode: AxisSizingMode;
  primaryAxisAlign: PrimaryAxisAlign;
  counterAxisAlign: CounterAxisAlign;
  itemSpacing: number;
  counterAxisSpacing: number | null;
  padding: { top: number; right: number; bottom: number; left: number };
  wrap: boolean;
}

export interface NodeSizing {
  horizontal: ChildSizingMode;
  vertical: ChildSizingMode;
}

export interface NodeFill {
  type: "SOLID" | "IMAGE";
  color?: RgbColor;       // SOLID
  imageRef?: string;      // IMAGE — opaque ref into an out-of-band asset map, never inline base64 in the tree
}

export interface NodeStroke {
  color: RgbColor;
  weight: number;
}

export interface TextStyle {
  characters: string;
  fontFamily: string;
  fontWeight: number;          // numeric CSS weight, 100-900
  italic: boolean;
  fontSizePx: number;
  lineHeightPx: number | "AUTO";
  letterSpacingPx: number;
  textAlign: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  color: RgbColor;
}

/** One node in the normalized, producer-agnostic tree. */
export interface ResolvedNode {
  kind: NodeKind;
  name: string;                 // best-effort human label (tag name, alt text, etc.)
  geometry: Rect;                // absolute px, relative to the capture root
  sizing: NodeSizing;
  layout: AutoLayout | null;     // null = NONE (absolute/static children)
  opacity: number;               // 0..1
  cornerRadius: number | [number, number, number, number]; // uniform or per-corner
  fills: NodeFill[];
  strokes: NodeStroke[];
  clipsContent: boolean;
  text: TextStyle | null;        // only for kind === "TEXT"
  vectorMarkup: string | null;   // raw inline <svg>...</svg>, only for kind === "VECTOR"
  tags: FlowfigTagAttributes;    // raw data-flowfig-* as captured, untouched — translator's input
  children: ResolvedNode[];
}

export interface FlowfigTagAttributes {
  component: string | null;      // data-flowfig-component
  props: Record<string, unknown> | null; // parsed data-flowfig-props JSON
  newComponent: string | null;   // data-flowfig-new-component
}

export interface ResolvedTree {
  formatVersion: FormatVersion;
  root: ResolvedNode;
}

// --- the three file kinds ---

export interface CaptureFile {
  kind: "capture";
  formatVersion: FormatVersion;
  capturedAt: string;   // ISO 8601, set by the producer, not by core
  sourceUrl: string | null;
  tree: ResolvedTree;
}

export interface TranslatedFile {
  kind: "translated";
  formatVersion: FormatVersion;
  generatedAt: string;
  sourceProject: string | null;
  tree: import("../translator/types.js").TranslatedTree;
}

export interface SymbolTableFile {
  kind: "symbols";
  formatVersion: FormatVersion;
  exportedAt: string;
  table: import("../translator/types.js").SymbolTable;
}
```

```ts
// format/errors.ts
export class FormatVersionMismatchError extends Error {
  constructor(public readonly expected: number, public readonly found: unknown) {
    super(`flowfig formatVersion mismatch: expected ${expected}, found ${JSON.stringify(found)}`);
  }
}

export class SchemaValidationError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`flowfig schema validation failed at "${path}": ${message}`);
  }
}
```

```ts
// format/validate.ts
export function assertFormatVersion(value: unknown): asserts value is FormatVersion;
export function parseCaptureFile(json: unknown): CaptureFile;      // throws SchemaValidationError/FormatVersionMismatchError
export function parseTranslatedFile(json: unknown): TranslatedFile;
export function parseSymbolTableFile(json: unknown): SymbolTableFile;
```

Validators are hand-rolled type guards (`typeof`/`Array.isArray`/discriminant checks), not a schema-validation library — see Requirements (bundle-size/dependency minimalism) and Open Risks (revisit if this gets unwieldy).

### `resolver/`

The resolver's own types are covered in full under **The Resolver Input Contract** below, since that section *is* this module's spec. Its function surface:

```ts
// resolver/resolve.ts
export function resolve(snapshot: RawDomSnapshot): ResolvedTree;

// resolver/layout.ts
export function inferAutoLayout(
  computed: NormalizedComputedStyle,
  children: readonly RawDomSnapshotNode[],
): AutoLayout | null;

// resolver/sizing.ts
export function inferSizing(
  computed: NormalizedComputedStyle,
  parentLayout: AutoLayout | null,
  childrenSizing: readonly NodeSizing[], // for the two-pass stretch-detection rule, see Research Finding #3
): NodeSizing;

// resolver/color.ts
export function parseCssColor(raw: string): RgbColor | null; // hex / rgb() / rgba() / hsl() / named / color()/oklch() best-effort

// resolver/text.ts
export function normalizeTextStyle(computed: NormalizedComputedStyle, characters: string): TextStyle;
```

### `translator/`

```ts
// translator/types.ts

export type ResolvedType = "BOOLEAN" | "FLOAT" | "STRING" | "COLOR";

export interface SymbolVariableEntry {
  id: string;                 // Figma variable id
  name: string;                // e.g. "color/accent/500"
  tokenRef: string;             // the --ffig-* custom-property name it corresponds to
  resolvedType: ResolvedType;
  valuesByMode: Record<string, unknown>;
}

export interface SymbolStyleEntry {
  id: string;
  name: string;
  type: "PAINT" | "TEXT" | "EFFECT" | "GRID";
}

export interface SymbolComponentEntry {
  key: string;                   // stable Figma component key
  name: string;
  variantProperties: Record<string, string[]> | null; // property name -> allowed values
}

export interface SymbolTable {
  components: SymbolComponentEntry[];
  variables: SymbolVariableEntry[];
  styles: SymbolStyleEntry[];
}

/** One declared CSS declaration that referenced a --ffig-* custom property,
 *  captured from source (agent-kit) or CSSOM (extension) — never derivable
 *  from computed style alone. See Research Finding #2. */
export interface DeclaredTokenRef {
  property: string;    // resolved CSS property name, e.g. "background-color"
  cssVariable: string; // e.g. "--ffig-color-accent-500"
}

export interface ComponentTagIndex {
  /** keyed by a stable per-node path so translator can re-attach results
   *  without mutating ResolvedNode identity. Path = array of child indices
   *  from tree root, e.g. [0, 2, 1]. */
  get(path: readonly number[]): FlowfigTagAttributes | undefined;
}

export type ComponentRef =
  | { kind: "existing"; key: string; props: Record<string, unknown> | null }
  | { kind: "new"; name: string };

export interface TokenRefAnnotation {
  property: string;
  variableId: string;
}

export interface TranslatedNode extends Omit<ResolvedNode, "children"> {
  componentRef: ComponentRef | null;
  tokenRefs: TokenRefAnnotation[];
  children: TranslatedNode[];
}

export interface TranslatedTree {
  formatVersion: FormatVersion;
  root: TranslatedNode;
}

export interface TranslateInput {
  tree: ResolvedTree;
  tags: ComponentTagIndex;
  declaredTokenRefs: Map<readonly number[], DeclaredTokenRef[]>; // per-node path, best-effort
  symbolTable: SymbolTable;
  matchOptions: import("../matching/types.js").MatchOptions;
}

export function translate(input: TranslateInput): TranslatedTree;
```

### `matching/`

```ts
// matching/types.ts

export type MatchMode = "value-only" | "structural";

export interface MatchOptions {
  mode: MatchMode;
  colorDeltaEThreshold: number;   // default 2.0 — see Research Finding #4
  colorExactThreshold: number;    // default 0.5
  spacingTolerancePx: number;     // default 1
  structuralSimilarityThreshold: number; // default 0.75, only used when mode === "structural"
}

export type MatchQuality = "exact" | "close" | "none";

export interface ColorMatchResult {
  quality: MatchQuality;
  variableId: string | null;
  deltaE: number | null;
}

export interface SpacingMatchResult {
  quality: MatchQuality;
  variableId: string | null;
  deltaPx: number | null;
}

/** Structure-only fingerprint of a subtree — deliberately abstract so both
 *  a ResolvedNode subtree (core) and a live Figma component (figma-plugin,
 *  built in P1, not here) can be projected into the same shape for comparison. */
export interface StructuralSignature {
  childKindSequence: NodeKind[];  // e.g. ["TEXT", "FRAME", "IMAGE"]
  depth: number;
  axis: Axis | null;
  textLeafCount: number;
  approxAspectRatio: number; // width / height, for coarse pre-filtering
}

export interface StructuralMatchResult {
  quality: MatchQuality;
  componentKey: string | null;
  similarity: number; // 0..1
}
```

```ts
// matching/color.ts
export function rgbToLab(color: RgbColor): { l: number; a: number; b: number };
export function deltaE76(a: RgbColor, b: RgbColor): number;
export function matchColor(
  value: RgbColor,
  candidates: readonly SymbolVariableEntry[], // resolvedType === "COLOR"
  opts: MatchOptions,
): ColorMatchResult;

// matching/spacing.ts
export function matchSpacing(
  px: number,
  candidates: readonly SymbolVariableEntry[], // resolvedType === "FLOAT"
  opts: MatchOptions,
): SpacingMatchResult;

// matching/structural.ts
export function computeStructuralSignature(node: ResolvedNode): StructuralSignature;
export function structuralSimilarity(a: StructuralSignature, b: StructuralSignature): number; // 0..1
export function matchComponentStructural(
  node: ResolvedNode,
  candidates: readonly { entry: SymbolComponentEntry; signature: StructuralSignature }[],
  opts: MatchOptions,
): StructuralMatchResult;
```

Note the last parameter shape: `matching/` does **not** know how to derive a `StructuralSignature` for a live Figma component — that projection is a P1 (scraper) concern living in `figma-plugin`, which will import `computeStructuralSignature`'s *type* contract but write its own Figma-node-side projector. `core` only owns the signature shape and the comparison, which is exactly the "shared by both plugin and extension" requirement without `core` depending on either runtime.

---

## The Resolver Input Contract

This is the linchpin: the exact shape both the Chrome extension's content script and agent-kit's Playwright driver must produce. `resolve()` accepts nothing else.

```ts
// resolver/types.ts

/** A fixed allowlist, not "whatever getComputedStyle returns" — both producers
 *  must read exactly these properties so the resolver's behavior doesn't
 *  silently depend on which one is calling it. Values are the raw strings
 *  from getComputedStyle(el).getPropertyValue(prop) / getPropertyValue for
 *  custom properties — no pre-parsing by the producer. */
export interface NormalizedComputedStyle {
  display: string;
  position: string;
  flexDirection: string;
  flexWrap: string;
  justifyContent: string;
  alignItems: string;
  gap: string;
  rowGap: string;
  columnGap: string;
  paddingTop: string; paddingRight: string; paddingBottom: string; paddingLeft: string;
  width: string; height: string;
  minWidth: string; minHeight: string;
  boxSizing: string;
  backgroundColor: string;
  backgroundImage: string;
  borderTopLeftRadius: string; borderTopRightRadius: string;
  borderBottomLeftRadius: string; borderBottomRightRadius: string;
  borderTopWidth: string; borderTopColor: string; // all 4 sides captured; abbreviated here
  opacity: string;
  overflow: string;
  color: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  /** any custom property starting with --ffig- that getComputedStyle
   *  exposes as an *inherited/cascaded value* — present for completeness,
   *  but NOT how token refs are detected (see declaredDeclarations below). */
  customProperties: Record<string, string>;
}

/** Declared-source side channel — the only reliable way to recover
 *  var(--ffig-*) usage, since computed style has already resolved it away.
 *  Populated from document.styleSheets / element.style (both producers can
 *  read this identically — see Research Finding #2) or, for agent-kit, from
 *  direct source-file parsing where available. Best-effort: may be empty. */
export interface DeclaredDeclaration {
  property: string;   // resolved property name this rule sets, e.g. "background-color"
  rawValue: string;    // the literal declared value text, e.g. "var(--ffig-color-accent-500)"
}

export interface RawDomSnapshotNode {
  nodeType: "element" | "text";
  tagName: string | null;              // null for text nodes
  textContent: string | null;           // only for text nodes; producer trims pure-whitespace runs
  attributes: Record<string, string>;    // includes data-flowfig-* verbatim
  computedStyle: NormalizedComputedStyle;
  declaredDeclarations: DeclaredDeclaration[];
  boundingBox: Rect;                     // getBoundingClientRect(), relative to capture root, in CSS px
  scrollSize: { width: number; height: number } | null; // for intrinsic/hug sizing checks; null if not applicable
  isSvgRoot: boolean;                    // true if this element is an inline <svg> root — resolver takes outerHTML as vectorMarkup and does not descend
  outerHTML: string | null;              // only populated when isSvgRoot is true
  children: RawDomSnapshotNode[];
}

export interface RawDomSnapshot {
  formatVersion: FormatVersion;
  source: "extension" | "agent-kit";
  capturedAt: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  root: RawDomSnapshotNode;
}
```

Contract notes that matter more than the types themselves:

- **The allowlist is the contract.** Both producers implement one shared helper — `extractComputedStyle(el): NormalizedComputedStyle` — that should itself live as a tiny, framework-free snippet documented in this contract (not shipped as executable code from `core`, since `core` cannot run in either the content-script or Playwright's page context — it only runs in the *host* process reading the JSON these produce). The extension and agent-kit packages each vendor this exact snippet; `examples/` fixtures are what keeps them from drifting (see below).
- **`declaredDeclarations` is best-effort and may legitimately be empty** for the extension when a page uses CSS-in-JS that doesn't insert readable stylesheet rules, or same-origin restrictions block `cssRules` access on a cross-origin `<link>` stylesheet. When empty, translator's token-matching for that node simply has nothing to match and falls through to the value-fuzzy-match path — this is a designed degradation, not an error.
- **`isSvgRoot` stops the walk.** Once hit, the resolver takes the raw markup as an opaque `VECTOR` leaf rather than resolving inner `<svg>` children as if they were HTML — inline SVG internals (`<path>`, `<use>`, etc.) are not part of this schema at all.
- **Geometry is always absolute-to-capture-root px**, never percentage, never relative to an intermediate ancestor — this is what lets the resolver compute `AutoLayout.padding`/`itemSpacing` by simple subtraction rather than re-deriving a box model.

---

## Fixture/Testing Strategy

`examples/` (already scaffolded, currently empty) holds one directory per test case, each a complete, hand-authored round-trip:

```
examples/
└── <case-name>/
    ├── raw.json           # RawDomSnapshot — input to resolve()
    ├── resolved.json       # ResolvedTree — expected output of resolve(raw.json), golden file
    ├── symbols.json         # SymbolTable — input to translate(), alongside resolved.json
    ├── tags.json            # ComponentTagIndex source data (or embedded in raw.json's attributes)
    └── translated.json      # TranslatedTree — expected output of translate(), golden file
```

Proposed initial cases for P0 (each exercises a distinct resolver/translator code path):

1. `flex-row-basic` — simple horizontal flex container, fixed children, no wrap.
2. `flex-column-hug` — vertical stack where container hugs contents (tests `AUTO` sizing mode + the two-pass stretch rule).
3. `absolute-overlay` — `position: absolute` children inside a `position: relative` parent (tests `layout: null` fallback).
4. `text-inherited-styles` — nested text where font/line-height/color are inherited rather than declared on the leaf (tests computed-style resolution, not cascade re-implementation).
5. `image-and-inline-svg` — one `<img>` (→ `IMAGE` fill) and one inline `<svg>` (→ `VECTOR`, opaque markup).
6. `tagged-component-with-props` — `data-flowfig-component` + `data-flowfig-props`, exercises translator's key-resolution path against `symbols.json`.
7. `tagged-new-component` — `data-flowfig-new-component`, exercises the `{kind:"new"}` `ComponentRef` path.
8. `token-ref-survives-cascade` — a node whose computed `background-color` is an RGB value but whose `declaredDeclarations` shows `var(--ffig-color-accent-500)`; proves the token-detection side-channel actually gets used instead of naively fuzzy-matching the resolved RGB.
9. `untagged-fallback-fuzzy` — no tags, no token refs; exercises `matching/` value-only mode end-to-end via translator's fallback.
10. `grid-container-flat` — CSS Grid parent; proves the documented `layoutMode: NONE` flattening decision (Research Finding #3), so it's a committed behavior, not an accidental gap.

Each case is a golden-file test: `test/resolver.spec.ts` iterates every case directory, calls `resolve(raw.json)`, and deep-equals against `resolved.json`; `test/translator.spec.ts` does the same for `translate()` against `translated.json`. `src/testing/fixtures.ts` provides `loadFixture(caseName)` so both `core`'s own tests and, later, `figma-plugin`/`extension`/`agent-kit`'s own test suites can load the same fixtures without duplicating them.

This is also the mechanism that keeps the two producers honest per the architecture plan's stated goal: once the extension and agent-kit exist (P2/P3), each adds its own test that feeds the *same conceptual DOM* (e.g., a literal HTML string matching `flex-row-basic`) through its own real capture mechanism (a real tab / a real Playwright page) and asserts the resulting `RawDomSnapshot` — or at least the `resolve()` output from it — matches `resolved.json`. `core` can't run that test itself (no browser), but by owning the golden `resolved.json` files it defines what "matching" means. Recommend documenting this expectation explicitly in `examples/README.md` once P2/P3 begin, so it isn't only implicit in this file.

Recommended test runner: **Vitest** — zero-config TS/ESM support, fast, and a dev-only dependency (never bundled into any consumer), so it doesn't conflict with the "minimal runtime dependencies" requirement above.

---

## Phase Task Breakdown (P0)

Ordered; each task should be its own commit/PR-sized unit.

1. **Scaffold the package.** `tsconfig.json` extending `tsconfig.base.json`; add `vitest` as a devDependency; wire `test`/`typecheck` scripts into root `package.json`'s workspace scripts (currently placeholders). Add an ESLint rule (or a small custom script) that fails the build if `format/`, `resolver/`, `translator/`, or `matching/` import `figma`, `chrome`, or any `node:` builtin.
2. **`format/types.ts`.** All shared types above (`ResolvedNode`, `RgbColor`, `AutoLayout`, the three file-kind wrappers). No logic yet — get the shape reviewed/stable first since everything else depends on it.
3. **`format/errors.ts` + `format/validate.ts`.** Hand-rolled guards; unit tests with deliberately malformed JSON (wrong `formatVersion`, missing fields, wrong discriminant) proving specific, actionable rejection — this is the "fails loudly and specifically" decision made testable.
4. **`resolver/types.ts`.** `RawDomSnapshot`/`RawDomSnapshotNode`/`NormalizedComputedStyle`/`DeclaredDeclaration` exactly as specified above. This is the contract other packages will eventually vendor a capture-side implementation against, so treat it as closer to "frozen" than other files once written.
5. **`resolver/color.ts`.** `parseCssColor` covering hex/`rgb()`/`rgba()`/`hsl()`/named colors at minimum; unit tests per format. (`oklch()`/`color()` wide-gamut handling can be a documented partial/TODO — see Open Risks.)
6. **`resolver/layout.ts` + `resolver/sizing.ts`.** Pure functions per the signatures above, including the two-pass stretch-detection rule from Research Finding #3 and the flattened-grid decision from Research Finding #3. Unit-test with small inline fixtures (not `examples/` yet) covering flex row/column, wrap, and the grid-flattening case.
7. **`resolver/text.ts` + `resolver/resolve.ts`.** Tree-walk composing the above into `resolve()`. At this point, author `examples/flex-row-basic`, `flex-column-hug`, `absolute-overlay`, `text-inherited-styles`, `image-and-inline-svg`, `grid-container-flat` (cases 1–5, 10) and write `test/resolver.spec.ts` as the golden-file harness.
8. **`translator/types.ts` + `translator/tags.ts`.** `ComponentTagIndex`, tag parsing (including `data-flowfig-props` JSON parse with a clear error on malformed JSON rather than a silent `null`). Unit tests.
9. **`translator/tokens.ts`.** Matches `DeclaredDeclaration`s carrying `var(--ffig-*)` against `SymbolTable.variables` by `tokenRef` name. Author `examples/token-ref-survives-cascade`.
10. **`matching/types.ts` + `matching/color.ts` + `matching/spacing.ts`.** CIE76 color distance, spacing nearest-neighbor, both modes of `MatchOptions`. Unit tests with a synthetic small symbol table.
11. **`matching/structural.ts`.** `StructuralSignature` + `structuralSimilarity`; unit tests with synthetic `ResolvedNode` trees only (no real Figma-side signature yet — that's P1's job).
12. **`translator/translate.ts`.** Compose tags + tokens + matching fallback into `TranslatedNode`. Author `examples/tagged-component-with-props`, `tagged-new-component`, `untagged-fallback-fuzzy`; write `test/translator.spec.ts`.
13. **`src/index.ts` barrel + `src/testing/fixtures.ts`.** Finalize the public export surface; confirm `figma-plugin`/`extension`/`agent-kit` package.json stubs can `import { resolve } from "@flowfig/core"` via the npm workspace without a build step (smoke-test with a throwaway script in each, or at minimum a `tsc --noEmit` cross-package import check).
14. **Write `examples/README.md` update** documenting the fixture-pairing contract from this file (case directory shape, what P2/P3 are expected to add later) so it isn't only recorded here.

---

## Open Risks / Questions

- **`declaredDeclarations` extraction is unproven for the extension side.** Reading `document.styleSheets` from a content script is possible for same-origin rules but can silently miss cross-origin `<link rel=stylesheet>` rules (CORS), Shadow DOM–encapsulated styles, and CSS-in-JS libraries that construct rules via `CSSStyleSheet.insertRule` in ways that may or may not be enumerable. Core's contract assumes this channel is "best-effort, sometimes empty," but nobody has validated against real-world sites yet — worth a spike before/alongside P3, and worth confirming agent-kit's path (parsing actual source files vs. reading Playwright's CSSOM) is decided consistently, since the architecture plan's own wording ("the CLI reads declared CSS source") reads as a possible third mechanism I inferred rather than one stated outright.
- **Grid-flattening (`layoutMode: NONE` for CSS Grid) may be too lossy in practice.** No inspected prior art solves this well, so this is a real judgment call, not a research-backed choice — worth a human sanity check once a few real Grid-heavy fixtures exist, particularly for agent-kit's generated-code use case where Grid is common in modern component libraries.
- **Wide-gamut color (`oklch()`, `color(display-p3 ...)`).** Modern Chrome computed style increasingly preserves these rather than serializing to `rgb()`. `parseCssColor`'s v1 scope (hex/rgb/hsl/named) will silently fail or lossy-clamp anything else; since Figma paints are sRGB anyway, some clamping is unavoidable, but the fallback behavior (null vs. best-effort clamp) needs a product decision, not just an engineering default.
- **Hand-rolled validation vs. a schema library.** Chose zero-dependency hand-rolled guards for bundle-size/sandbox-safety reasons. If the schema grows materially more complex than what's sketched here (nested unions, optional fields proliferating), revisit — a tiny validation library or even a generated-from-types approach may pay for itself. Flagging now so it isn't re-litigated from scratch later.
- **Structural-signature symmetry with Figma nodes is deferred, not designed.** `matching/structural.ts` only defines the DOM-tree side (`computeStructuralSignature(node: ResolvedNode)`). The Figma-node-side projector (needed by P1's scraper and P3's extension) isn't designed here at all — there's real risk the two projections won't naturally line up (e.g., Figma auto-layout "wrapper" frames with no DOM equivalent) unless P1 explicitly designs against this file's `StructuralSignature` shape rather than inventing its own.
- **The "raw TS, no compiled dist" decision holds** under this design — reasoning confirmed during research: all four modules are pure, dependency-light, target-agnostic TS with no build-specific syntax requirements, so each consumer's bundler (esbuild via `@create-figma-plugin`, whatever agent-kit's CLI bundler ends up being, and the extension's MV3 bundler) can compile `core`'s source directly at its own target with no intermediate step. The one thing worth flagging: `@create-figma-plugin`'s esbuild config and agent-kit's CLI bundler both need their `tsconfig`/module-resolution set up to resolve workspace-linked `.ts` sources (not just `.d.ts` + compiled `.js`) — this is a known-solvable, well-trodden setup (`moduleResolution: "bundler"` or equivalent), but it's untested in *this* repo until P1 actually wires it up, so treat "core imports cleanly from figma-plugin" as a P1 acceptance check, not an assumption.

---

*`@flowfig/core` · architecture plan · P0 scope · no source code written yet.*
