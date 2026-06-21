// Template rendering: {{var}} substitution + {a|b|c} variant syntax.
//
// The {a|b|c} variant syntax is a copywriting convenience. Variant selection is
// deterministic per target so preview and send use the same final text.

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const SPIN_RE = /\{([^{}]*\|[^{}]*)\}/g;

// Returns the list of distinct {{var}} names referenced in the body.
export function extractVars(body) {
  const set = new Set();
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(body))) set.add(m[1]);
  return [...set];
}

// Stable hash so a given target always renders the same variant choice.
export function seedFrom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function applyVariants(body, seed) {
  let n = 0;
  return body.replace(SPIN_RE, (_, group) => {
    const opts = group.split('|').map((s) => s.trim());
    return opts[(seed + n++) % opts.length] || '';
  });
}

// Renders the body for a target's vars. Returns { text, missing, length }.
// `missing` lists vars referenced in the template but absent for this target;
// those are left as literal {{var}} so they are obvious in the preview.
export function render(body, vars = {}, seed = 0) {
  const withVariants = applyVariants(body || '', seed);
  const missing = [];
  const text = withVariants.replace(VAR_RE, (_, key) => {
    const v = vars[key];
    if (v != null && String(v).trim() !== '') return String(v);
    missing.push(key);
    return `{{${key}}}`;
  });
  return { text, missing, length: [...text].length };
}
