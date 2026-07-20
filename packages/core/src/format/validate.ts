import { FORMAT_VERSION } from './types.js'
import type { CaptureFile, SymbolTableFile, TranslatedFile } from './types.js'
import { FormatVersionMismatchError, SchemaValidationError } from './errors.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertFormatVersion(value: unknown): asserts value is typeof FORMAT_VERSION {
  if (value !== FORMAT_VERSION) {
    throw new FormatVersionMismatchError(FORMAT_VERSION, value)
  }
}

export function parseCaptureFile(json: unknown): CaptureFile {
  if (!isPlainObject(json)) {
    throw new SchemaValidationError('$', 'expected an object')
  }
  if (json.kind !== 'capture') {
    throw new SchemaValidationError('$.kind', `expected "capture", found ${JSON.stringify(json.kind)}`)
  }
  assertFormatVersion(json.formatVersion)
  if (typeof json.capturedAt !== 'string') {
    throw new SchemaValidationError('$.capturedAt', 'expected a string')
  }
  if (json.sourceUrl !== null && typeof json.sourceUrl !== 'string') {
    throw new SchemaValidationError('$.sourceUrl', 'expected a string or null')
  }
  if (!isPlainObject(json.tree)) {
    throw new SchemaValidationError('$.tree', 'expected an object')
  }
  return json as unknown as CaptureFile
}

export function parseTranslatedFile(json: unknown): TranslatedFile {
  if (!isPlainObject(json)) {
    throw new SchemaValidationError('$', 'expected an object')
  }
  if (json.kind !== 'translated') {
    throw new SchemaValidationError('$.kind', `expected "translated", found ${JSON.stringify(json.kind)}`)
  }
  assertFormatVersion(json.formatVersion)
  if (typeof json.generatedAt !== 'string') {
    throw new SchemaValidationError('$.generatedAt', 'expected a string')
  }
  if (json.sourceProject !== null && typeof json.sourceProject !== 'string') {
    throw new SchemaValidationError('$.sourceProject', 'expected a string or null')
  }
  if (!isPlainObject(json.tree)) {
    throw new SchemaValidationError('$.tree', 'expected an object')
  }
  return json as unknown as TranslatedFile
}

export function parseSymbolTableFile(json: unknown): SymbolTableFile {
  if (!isPlainObject(json)) {
    throw new SchemaValidationError('$', 'expected an object')
  }
  if (json.kind !== 'symbols') {
    throw new SchemaValidationError('$.kind', `expected "symbols", found ${JSON.stringify(json.kind)}`)
  }
  assertFormatVersion(json.formatVersion)
  if (typeof json.exportedAt !== 'string') {
    throw new SchemaValidationError('$.exportedAt', 'expected a string')
  }
  if (!isPlainObject(json.table)) {
    throw new SchemaValidationError('$.table', 'expected an object')
  }
  return json as unknown as SymbolTableFile
}
