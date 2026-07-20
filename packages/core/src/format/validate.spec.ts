import { describe, expect, it } from 'vitest'
import { FORMAT_VERSION } from './types.js'
import { assertFormatVersion, parseCaptureFile, parseSymbolTableFile, parseTranslatedFile } from './validate.js'
import { FormatVersionMismatchError, SchemaValidationError } from './errors.js'

describe('assertFormatVersion', () => {
  it('accepts the current format version', () => {
    expect(() => assertFormatVersion(FORMAT_VERSION)).not.toThrow()
  })

  it('rejects a mismatched format version', () => {
    expect(() => assertFormatVersion(999)).toThrow(FormatVersionMismatchError)
  })

  it('rejects a missing format version', () => {
    expect(() => assertFormatVersion(undefined)).toThrow(FormatVersionMismatchError)
  })
})

describe('parseCaptureFile', () => {
  const valid = {
    kind: 'capture',
    formatVersion: FORMAT_VERSION,
    capturedAt: '2026-01-01T00:00:00.000Z',
    sourceUrl: 'https://example.com',
    tree: { formatVersion: FORMAT_VERSION, root: {} },
  }

  it('accepts a well-formed capture file', () => {
    expect(() => parseCaptureFile(valid)).not.toThrow()
  })

  it('rejects a non-object payload', () => {
    expect(() => parseCaptureFile(null)).toThrow(SchemaValidationError)
    expect(() => parseCaptureFile('not json')).toThrow(SchemaValidationError)
  })

  it('rejects a wrong discriminant', () => {
    expect(() => parseCaptureFile({ ...valid, kind: 'translated' })).toThrow(SchemaValidationError)
  })

  it('rejects a mismatched formatVersion', () => {
    expect(() => parseCaptureFile({ ...valid, formatVersion: 2 })).toThrow(FormatVersionMismatchError)
  })

  it('rejects a missing capturedAt', () => {
    const { capturedAt: _capturedAt, ...rest } = valid
    expect(() => parseCaptureFile(rest)).toThrow(SchemaValidationError)
  })

  it('rejects a missing tree', () => {
    const { tree: _tree, ...rest } = valid
    expect(() => parseCaptureFile(rest)).toThrow(SchemaValidationError)
  })
})

describe('parseTranslatedFile', () => {
  const valid = {
    kind: 'translated',
    formatVersion: FORMAT_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    sourceProject: null,
    tree: { formatVersion: FORMAT_VERSION, root: {} },
  }

  it('accepts a well-formed translated file', () => {
    expect(() => parseTranslatedFile(valid)).not.toThrow()
  })

  it('rejects a wrong discriminant', () => {
    expect(() => parseTranslatedFile({ ...valid, kind: 'capture' })).toThrow(SchemaValidationError)
  })

  it('rejects a mismatched formatVersion', () => {
    expect(() => parseTranslatedFile({ ...valid, formatVersion: 0 })).toThrow(FormatVersionMismatchError)
  })
})

describe('parseSymbolTableFile', () => {
  const valid = {
    kind: 'symbols',
    formatVersion: FORMAT_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    table: { components: [], variables: [], styles: [] },
  }

  it('accepts a well-formed symbol table file', () => {
    expect(() => parseSymbolTableFile(valid)).not.toThrow()
  })

  it('rejects a wrong discriminant', () => {
    expect(() => parseSymbolTableFile({ ...valid, kind: 'capture' })).toThrow(SchemaValidationError)
  })

  it('rejects a missing table', () => {
    const { table: _table, ...rest } = valid
    expect(() => parseSymbolTableFile(rest)).toThrow(SchemaValidationError)
  })
})
