// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
//
// Same answer as vendor/csv-reader's readCsv for every input, but instead of
// building each field a character at a time it scans with charCodeAt and cuts
// each field out with one slice, jumping between quotes with indexOf. Only
// the rare paths (a stray CR inside a field, a line break inside quotes, a
// doubled quote) pay for extra work.
//
// Semantics, kept exactly as the reference:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, and each CRLF or lone CR inside it is
//     read as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character, and the text after it is
//     read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside a quoted field counted),
//     row its record's index in rows (null for the header), in the order met,
//     a field's quote_junk when the field ends and a record's short_row or
//     long_row when the record ends.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next. No dependencies, no WebAssembly, no native code.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters
  // were kept into it after its starting value (0 for a quoted field; the
  // junk count for a quoted field read on past its closing quote).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // The slice text[a..b] as a quoted field's content: each CRLF or lone CR
  // in it is one LF, and each counts one line. The common case (no CR or LF
  // in it) returns the slice untouched.
  function normSeg(a, b) {
    if (b <= a) return '';
    const seg = text.slice(a, b);
    if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) return seg;
    const breaks = seg.match(/\r\n?|\n/g);
    if (breaks !== null) line += breaks.length;
    return seg.replace(/\r\n?/g, '\n');
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Sets fValue,
  // fEnded and fAdded (the characters kept after `value`).
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // ','
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      if (c === 10) {
        // '\n'
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      if (c === 13) {
        // '\r'
        if (text.charCodeAt(pos + 1) === 10) {
          value += text.slice(start, pos);
          added += pos - start;
          pos += 2;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          fAdded = added;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    value += text.slice(start, pos);
    added += pos - start;
    fValue = value;
    fEnded = END;
    fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue, fEnded
  // and fAdded (the characters kept past the closing quote, if any).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let segStart = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // '""' inside the field is one quote.
        value += normSeg(segStart, q) + '"';
        pos = q + 2;
        segStart = pos;
        continue;
      }
      // The closing quote.
      value += normSeg(segStart, q);
      pos = q + 1;
      if (pos >= len) {
        fValue = value;
        fEnded = END;
        fAdded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record on one line with no quote and no stray CR. A quote
    // anywhere on the line (a quoted field may span lines, hold a doubled
    // quote or carry junk) or a CR other than a closing CRLF's falls back to
    // the field-by-field reader below, which is the exact semantics.
    let fields = null;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let s = text.slice(pos, lineEnd);
    if (nl !== -1 && s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
    if (s.length > 0 && s.indexOf('"') === -1 && s.indexOf('\r') === -1) {
      fields = s.split(',');
      if (nl === -1) pos = len;
      else {
        pos = nl + 1;
        line += 1;
      }
    }

    if (fields === null) {
      fields = [];
      let quoted = false;
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) readQuoted();
        else readUnquoted('');
        fields.push(fValue);
      } while (fEnded === COMMA);

      // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// JIT warm-up: run() is pure and keeps nothing from one call to the next,
// so warming it on a small fixed synthetic input (never case data) only gets
// the parser's hot paths compiled before the first real case is read.
{
  const warm = {
    text: 'a,b,c\n"1","2","3"\n4,5,6\r\n"x""y",z,"multi\nline"\nshort,row\n',
    header: true,
  };
  for (let i = 0; i < 200; i++) run(warm);
}
