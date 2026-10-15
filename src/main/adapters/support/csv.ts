/**
 * A small, correct CSV reader.
 *
 * Sherlock and holehe are CSV-only — sherlock's `--json` flag is an *input* flag that
 * loads a site database, not an output format — so parsing CSV properly is not optional
 * here. Splitting on commas would be wrong the first time a site name contains one, and
 * "Yahoo, Inc." style names do occur in these datasets.
 *
 * RFC 4180 with the usual real-world tolerances: CRLF or LF, a doubled `""` inside a
 * quoted field, and a trailing newline. It never throws; a ragged row is padded or
 * trimmed to the header width, because losing one malformed row must not cost the file.
 */

export interface CsvTable {
  header: string[]
  /** One record per row, keyed by header name. Missing cells are `''`. */
  rows: Record<string, string>[]
  /** Rows whose cell count did not match the header. Reported, not fatal. */
  raggedRows: number
}

/** Split CSV text into a matrix of raw cells. */
export function parseCsvMatrix(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let touched = false

  const endField = (): void => {
    row.push(field)
    field = ''
    touched = true
  }
  const endRow = (): void => {
    if (touched || row.length) {
      row.push(field)
      rows.push(row)
    }
    row = []
    field = ''
    touched = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      touched = true
      continue
    }
    if (ch === ',') {
      endField()
      continue
    }
    if (ch === '\r') continue
    if (ch === '\n') {
      endRow()
      continue
    }
    field += ch
    touched = true
  }
  if (touched || field || row.length) endRow()
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '')
}

/** Parse CSV with a header row. An empty or header-only file yields zero rows, not an error. */
export function parseCsv(text: string | null | undefined): CsvTable {
  if (typeof text !== 'string' || !text.trim()) return { header: [], rows: [], raggedRows: 0 }
  const matrix = parseCsvMatrix(text)
  const header = (matrix[0] ?? []).map((h) => h.trim())
  if (!header.length) return { header: [], rows: [], raggedRows: 0 }

  const rows: Record<string, string>[] = []
  let raggedRows = 0
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? []
    if (cells.length !== header.length) raggedRows++
    const record: Record<string, string> = {}
    for (let c = 0; c < header.length; c++) {
      record[header[c] as string] = (cells[c] ?? '').trim()
    }
    rows.push(record)
  }
  return { header, rows, raggedRows }
}

/**
 * These tools write Python booleans (`True` / `False`) into CSV. Anything unrecognised
 * comes back `null` rather than `false`, because "the field was blank" and "the tool said
 * no" are different facts and collapsing them is how a parser starts lying.
 */
export function pyBool(value: string | undefined): boolean | null {
  const v = (value ?? '').trim().toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  return null
}
