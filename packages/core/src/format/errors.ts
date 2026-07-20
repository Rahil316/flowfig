export class FormatVersionMismatchError extends Error {
  public readonly expected: number
  public readonly found: unknown

  constructor(expected: number, found: unknown) {
    super(`flowfig formatVersion mismatch: expected ${expected}, found ${JSON.stringify(found)}`)
    this.name = 'FormatVersionMismatchError'
    this.expected = expected
    this.found = found
  }
}

export class SchemaValidationError extends Error {
  public readonly path: string

  constructor(path: string, message: string) {
    super(`flowfig schema validation failed at "${path}": ${message}`)
    this.name = 'SchemaValidationError'
    this.path = path
  }
}
