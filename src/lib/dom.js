import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/** Escape text for safe insertion into HTML. Use for anything a user typed. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Markdown is also used for homebrew, which other players write, so raw HTML
// is cut down to a few plain tags (the SRD's tables) with no attributes except
// colspan, and links can only go to http(s) or in-site (#) addresses.
const SAFE_TAGS = new Set(['table', 'thead', 'tbody', 'tr', 'td', 'th', 'br', 'hr', 'em', 'strong', 'b', 'i', 'ul', 'ol', 'li', 'p', 'sup', 'sub']);
export function cleanHtml(s) {
  return String(s ?? '').replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>|</g, (m, slash, name, attrs) => {
    const tag = name?.toLowerCase();
    if (!tag || !SAFE_TAGS.has(tag)) return m.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const span = !slash && /^(td|th)$/.test(tag) ? attrs.match(/colspan="?(\d{1,2})"?/i) : null;
    return `<${slash}${tag}${span ? ` colspan="${span[1]}"` : ''}>`;
  });
}
const safeUrl = (href) => (/^(https?:|#|\/|mailto:)/i.test(String(href || '').trim()) ? href : '#');
marked.use({
  renderer: {
    html(token) {
      return cleanHtml(token.text ?? token.raw);
    },
  },
  walkTokens(token) {
    if (token.type === 'link' || token.type === 'image') token.href = safeUrl(token.href);
  },
});

/** Render Markdown to HTML (rules text and homebrew). */
export function rulesMarkdown(md) {
  return marked.parse(String(md || ''));
}

/** Tiny tagged-template helper: html`<p>${x}</p>` escapes x unless it's a raw() value. */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += renderValue(values[i]);
  });
  return raw(out);
}

function renderValue(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (v instanceof Raw) return v.value;
  return esc(v);
}

class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** Mark a string as already-safe HTML. */
export function raw(value) {
  return new Raw(String(value ?? ''));
}

/** Delay calls until `ms` after the last one. `.flush()` runs a pending call now. */
export function debounce(fn, ms = 150) {
  let t;
  let pending = null;
  const debounced = (...args) => {
    clearTimeout(t);
    pending = args;
    t = setTimeout(() => {
      pending = null;
      fn(...args);
    }, ms);
  };
  debounced.flush = () => {
    if (!pending) return;
    clearTimeout(t);
    const args = pending;
    pending = null;
    fn(...args);
  };
  return debounced;
}
