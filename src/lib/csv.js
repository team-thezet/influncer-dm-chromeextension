// CSV utilities: a small RFC-4180-ish parser + serializer, plus a flexible
// importer that accepts either pasted handle lines or a CSV with a handle
// column and extra personalization fields.

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  pushField();
  if (row.length > 1 || row[0] !== '') pushRow();
  return rows;
}

export function toCSV(headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [headers.map(esc).join(',')];
  for (const r of rows) out.push(headers.map((h) => esc(r[h])).join(','));
  return out.join('\r\n');
}

const HANDLE_COLS = ['handle', 'username', 'user', 'account', '핸들', '아이디', '계정', '유저명'];

const cleanHandle = (h) =>
  String(h)
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/[/?#].*$/, '')
    .trim();

const validHandle = (h) => /^[A-Za-z0-9._]{1,30}$/.test(h);

// Accepts pasted lines of handles OR CSV (with a recognizable handle column).
// Returns [{ handle, vars }]. Deduplicates within the input by handle.
export function importTargets(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];

  const rows = parseCSV(trimmed);
  const header = rows[0] || [];
  const headerLower = header.map((h) => h.trim().toLowerCase());
  const looksCSV =
    header.length > 1 || HANDLE_COLS.includes((header[0] || '').trim().toLowerCase());

  const seen = new Set();
  const out = [];

  if (!looksCSV) {
    for (const line of trimmed.split(/\r?\n/)) {
      const h = cleanHandle(line);
      const key = h.toLowerCase();
      if (!h || !validHandle(h) || seen.has(key)) continue;
      seen.add(key);
      out.push({ handle: h, vars: {} });
    }
    return out;
  }

  let hIdx = headerLower.findIndex((c) => HANDLE_COLS.includes(c));
  if (hIdx < 0) hIdx = 0;

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const h = cleanHandle(cells[hIdx] || '');
    const key = h.toLowerCase();
    if (!h || !validHandle(h) || seen.has(key)) continue;
    seen.add(key);
    const vars = {};
    headerLower.forEach((col, idx) => {
      if (idx === hIdx) return;
      const val = cells[idx];
      if (col && val != null && val !== '') vars[col] = val;
    });
    out.push({ handle: h, vars });
  }
  return out;
}
