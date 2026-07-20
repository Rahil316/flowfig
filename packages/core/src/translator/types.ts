import type { FormatVersion, NodeKind, ResolvedNode } from '../format/types.js'
import type { MatchOptions } from '../matching/types.js'

export type ResolvedType = 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR'
export type SymbolStyleType = 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID'

/**
 * Reconciled against figma-plugin/ARCHITECTURE.md's concrete `.flowfig/symbols.json`
 * shape (the Figma-API-grounded draft), per the cross-package contract gate in
 * Documentation/PROJECT-TRACKING.md — figma-plugin's fields win where the two
 * drafts diverged (modes/scopes/collection, variantOf).
 */
export interface SymbolVariableEntry {
  id: string // Figma variable id
  key: string // stable Figma variable key
  name: string // e.g. "color/accent/500"
  tokenRef: string // the --ffig-* custom-property name it corresponds to
  resolvedType: ResolvedType
  collection: string
  /** per-mode literal values, e.g. { "Light": {...RgbColor}, "Dark": {...RgbColor} } or { "Value": 16 } */
  modes: Record<string, unknown>
  scopes: string[]
}

export interface SymbolStyleEntry {
  id: string
  key: string
  name: string
  type: SymbolStyleType
  resolved: Record<string, unknown>
}

export interface SymbolComponentEntry {
  key: string // stable Figma component key
  name: string
  variantProperties: Record<string, string[]> | null // property name -> allowed values
  variantOf: string | null // parent component-set key, if this is a variant
}

export interface SymbolTable {
  components: SymbolComponentEntry[]
  variables: SymbolVariableEntry[]
  styles: SymbolStyleEntry[]
}

/**
 * One declared CSS declaration that referenced a --ffig-* custom property,
 * captured from source (agent-kit) or CSSOM (extension) — never derivable
 * from computed style alone.
 */
export interface DeclaredTokenRef {
  property: string // resolved CSS property name, e.g. "background-color"
  cssVariable: string // e.g. "--ffig-color-accent-500"
}

/**
 * Keyed by a stable per-node path so translator can re-attach results
 * without mutating ResolvedNode identity. Path = array of child indices
 * from tree root, e.g. [0, 2, 1].
 */
export interface ComponentTagIndex {
  get(path: readonly number[]): ResolvedNode['tags'] | undefined
}

export type ComponentRef =
  | { kind: 'existing'; key: string; props: Record<string, unknown> | null }
  | { kind: 'new'; name: string }

export interface TokenRefAnnotation {
  property: string
  variableId: string
}

export interface TranslatedNode extends Omit<ResolvedNode, 'children'> {
  kind: NodeKind
  componentRef: ComponentRef | null
  tokenRefs: TokenRefAnnotation[]
  children: TranslatedNode[]
}

export interface TranslatedTree {
  formatVersion: FormatVersion
  root: TranslatedNode
}

export interface TranslateInput {
  tree: import('../format/types.js').ResolvedTree
  tags: ComponentTagIndex
  declaredTokenRefs: Map<readonly number[], DeclaredTokenRef[]> // per-node path, best-effort
  symbolTable: SymbolTable
  matchOptions: MatchOptions
}
