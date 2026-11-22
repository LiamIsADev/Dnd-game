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

/**
 * Render Markdown to HTML. Only use this for the bundled SRD rules text,
 * which we ship ourselves. Never pass user-written text through it.
 */
export function rulesMarkdown(md) {
  return marked.parse(md || '');
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
