import type { TranslatedTree } from '../translator/types.js'
import type { SymbolTable } from '../translator/types.js'

export const FORMAT_VERSION = 1
export type FormatVersion = typeof FORMAT_VERSION

export type NodeKind = 'FRAME' | 'TEXT' | 'IMAGE' | 'VECTOR'

export interface RgbColor {
  r: number // 0..1
  g: number // 0..1
  b: number // 0..1
  a: number // 0..1, 1 = opaque
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Axis = 'HORIZONTAL' | 'VERTICAL'
export type AxisSizingMode = 'FIXED' | 'AUTO' // AUTO = hug contents
export type ChildSizingMode = 'FIXED' | 'HUG' | 'FILL'
export type PrimaryAxisAlign = 'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN'
export type CounterAxisAlign = 'MIN' | 'MAX' | 'CENTER' | 'BASELINE'

export interface AutoLayoutPadding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface AutoLayout {
  axis: Axis
  primaryAxisSizingMode: AxisSizingMode
  counterAxisSizingMode: AxisSizingMode
  primaryAxisAlign: PrimaryAxisAlign
  counterAxisAlign: CounterAxisAlign
  itemSpacing: number
  counterAxisSpacing: number | null
  padding: AutoLayoutPadding
  wrap: boolean
}

export interface NodeSizing {
  horizontal: ChildSizingMode
  vertical: ChildSizingMode
}

export type NodeFillType = 'SOLID' | 'IMAGE'

export interface NodeFill {
  type: NodeFillType
  color?: RgbColor // SOLID
  imageRef?: string // IMAGE — opaque ref into an out-of-band asset map, never inline base64 in the tree
}

export interface NodeStroke {
  color: RgbColor
  weight: number
}

export type TextAlign = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'

export interface TextStyle {
  characters: string
  fontFamily: string
  fontWeight: number // numeric CSS weight, 100-900
  italic: boolean
  fontSizePx: number
  lineHeightPx: number | 'AUTO'
  letterSpacingPx: number
  textAlign: TextAlign
  color: RgbColor
}

export type CornerRadius = number | [number, number, number, number] // uniform or per-corner

export interface FlowfigTagAttributes {
  component: string | null // data-flowfig-component
  props: Record<string, unknown> | null // parsed data-flowfig-props JSON
  newComponent: string | null // data-flowfig-new-component
}

/** One node in the normalized, producer-agnostic tree. */
export interface ResolvedNode {
  kind: NodeKind
  name: string // best-effort human label (tag name, alt text, etc.)
  geometry: Rect // absolute px, relative to the capture root
  sizing: NodeSizing
  layout: AutoLayout | null // null = NONE (absolute/static children)
  opacity: number // 0..1
  cornerRadius: CornerRadius
  fills: NodeFill[]
  strokes: NodeStroke[]
  clipsContent: boolean
  text: TextStyle | null // only for kind === "TEXT"
  vectorMarkup: string | null // raw inline <svg>...</svg>, only for kind === "VECTOR"
  tags: FlowfigTagAttributes // raw data-flowfig-* as captured, untouched — translator's input
  children: ResolvedNode[]
}

export interface ResolvedTree {
  formatVersion: FormatVersion
  root: ResolvedNode
}

// --- the three file kinds ---

export interface CaptureFile {
  kind: 'capture'
  formatVersion: FormatVersion
  capturedAt: string // ISO 8601, set by the producer, not by core
  sourceUrl: string | null
  tree: ResolvedTree
}

export interface TranslatedFile {
  kind: 'translated'
  formatVersion: FormatVersion
  generatedAt: string
  sourceProject: string | null
  tree: TranslatedTree
}

export interface SymbolTableFile {
  kind: 'symbols'
  formatVersion: FormatVersion
  exportedAt: string
  table: SymbolTable
}

export type FlowfigFile = CaptureFile | TranslatedFile | SymbolTableFile
