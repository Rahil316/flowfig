import type { Axis, NodeKind } from '../format/types.js'

export type MatchMode = 'value-only' | 'structural'

export interface MatchOptions {
  mode: MatchMode
  colorDeltaEThreshold: number // default 2.0
  colorExactThreshold: number // default 0.5
  spacingTolerancePx: number // default 1
  structuralSimilarityThreshold: number // default 0.75, only used when mode === "structural"
}

export type MatchQuality = 'exact' | 'close' | 'none'

export interface ColorMatchResult {
  quality: MatchQuality
  variableId: string | null
  deltaE: number | null
}

export interface SpacingMatchResult {
  quality: MatchQuality
  variableId: string | null
  deltaPx: number | null
}

/**
 * Structure-only fingerprint of a subtree — deliberately abstract so both
 * a ResolvedNode subtree (core) and a live Figma component (figma-plugin,
 * built in P1, not here) can be projected into the same shape for comparison.
 */
export interface StructuralSignature {
  childKindSequence: NodeKind[] // e.g. ["TEXT", "FRAME", "IMAGE"]
  depth: number
  axis: Axis | null
  textLeafCount: number
  approxAspectRatio: number // width / height, for coarse pre-filtering
}

export interface StructuralMatchResult {
  quality: MatchQuality
  componentKey: string | null
  similarity: number // 0..1
}
