import type { FormatVersion, Rect } from '../format/types.js'

/**
 * A fixed allowlist, not "whatever getComputedStyle returns" — both producers
 * must read exactly these properties so the resolver's behavior doesn't
 * silently depend on which one is calling it. Values are the raw strings
 * from getComputedStyle(el).getPropertyValue(prop) / getPropertyValue for
 * custom properties — no pre-parsing by the producer.
 */
export interface NormalizedComputedStyle {
  display: string
  position: string
  flexDirection: string
  flexWrap: string
  justifyContent: string
  alignItems: string
  gap: string
  rowGap: string
  columnGap: string
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
  width: string
  height: string
  minWidth: string
  minHeight: string
  boxSizing: string
  backgroundColor: string
  backgroundImage: string
  borderTopLeftRadius: string
  borderTopRightRadius: string
  borderBottomLeftRadius: string
  borderBottomRightRadius: string
  borderTopWidth: string
  borderRightWidth: string
  borderBottomWidth: string
  borderLeftWidth: string
  borderTopColor: string
  borderRightColor: string
  borderBottomColor: string
  borderLeftColor: string
  opacity: string
  overflow: string
  color: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  fontStyle: string
  lineHeight: string
  letterSpacing: string
  textAlign: string
  /**
   * any custom property starting with --ffig- that getComputedStyle
   * exposes as an *inherited/cascaded value* — present for completeness,
   * but NOT how token refs are detected (see declaredDeclarations below).
   */
  customProperties: Record<string, string>
}

/**
 * Declared-source side channel — the only reliable way to recover
 * var(--ffig-*) usage, since computed style has already resolved it away.
 * Populated from document.styleSheets / element.style (both producers can
 * read this identically) or, for agent-kit, from direct source-file parsing
 * where available. Best-effort: may be empty.
 */
export interface DeclaredDeclaration {
  property: string // resolved property name this rule sets, e.g. "background-color"
  rawValue: string // the literal declared value text, e.g. "var(--ffig-color-accent-500)"
}

/**
 * Opaqueness annotations for subtrees the producer structurally cannot see
 * into — a closed shadow root or a cross-origin iframe. Additive metadata:
 * absent entirely for a producer (e.g. agent-kit) that has nothing to report.
 * When either is set, the resolver takes this node as an opaque leaf and
 * does not expect meaningful `children`.
 */
export interface ShadowAnnotation {
  mode: 'open' | 'closed-opaque'
}

export interface FrameAnnotation {
  origin: 'same-origin' | 'cross-origin-opaque'
  src: string
}

export interface RawDomSnapshotNode {
  nodeType: 'element' | 'text'
  tagName: string | null // null for text nodes
  textContent: string | null // only for text nodes; producer trims pure-whitespace runs
  attributes: Record<string, string> // includes data-flowfig-* verbatim
  computedStyle: NormalizedComputedStyle
  declaredDeclarations: DeclaredDeclaration[]
  boundingBox: Rect // getBoundingClientRect(), relative to capture root, in CSS px
  scrollSize: { width: number; height: number } | null // for intrinsic/hug sizing checks; null if not applicable
  isSvgRoot: boolean // true if this element is an inline <svg> root — resolver takes outerHTML as vectorMarkup and does not descend
  outerHTML: string | null // only populated when isSvgRoot is true
  shadow: ShadowAnnotation | null // set only for a shadow-host element
  frame: FrameAnnotation | null // set only for an iframe element
  children: RawDomSnapshotNode[]
}

export interface RawDomSnapshot {
  formatVersion: FormatVersion
  source: 'extension' | 'agent-kit'
  capturedAt: string
  viewport: { width: number; height: number; devicePixelRatio: number }
  root: RawDomSnapshotNode
}
