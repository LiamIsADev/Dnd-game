// Small helpers for turning the SRD Markdown files into structured data.
// The SRD files mix Markdown with simple HTML tables, so these helpers stay
// deliberately small and regex-based rather than pulling in a full parser.

/** Make a URL-safe id from a name, e.g. "Acid Arrow" -> "acid-arrow". */
export function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Split Markdown into sections at headings of exactly `level` (e.g. 4 for "####").
 * Returns [{ title, body }] where body excludes the heading line.
 * Text before the first heading is dropped.
 */
export function splitByHeading(markdown, level) {
  const marker = '#'.repeat(level) + ' ';
  const lines = markdown.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith(marker)) {
      if (current) sections.push(current);
      current = { title: line.slice(marker.length).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map(({ title, lines: l }) => ({ title, body: l.join('\n').trim() }));
}

/** Return the text between a heading line and the next heading of the same or higher level. */
export function sectionAfter(markdown, headingLine) {
  const start = markdown.indexOf(headingLine + '\n');
  if (start === -1) throw new Error(`Heading not found: ${headingLine}`);
  const level = headingLine.match(/^#+/)[0].length;
  const rest = markdown.slice(start + headingLine.length + 1);
  const stop = new RegExp(`^#{1,${level}} `, 'm');
  const m = rest.match(stop);
  return (m ? rest.slice(0, m.index) : rest).trim();
}

/** Strip simple Markdown/HTML formatting to plain text. */
export function plain(text) {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&emsp;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read "**Label:** value" lines into an object keyed by label. */
export function boldFields(body) {
  const out = {};
  const re = /^\*\*([^*]+?):\*\*\s*(.*)$/gm;
  let m;
  while ((m = re.exec(body))) out[m[1].trim()] = m[2].trim();
  return out;
}

/**
 * Parse a simple HTML table into rows of cell text.
 * Header rows (<th>) are returned with `header: true` so callers can track groups.
 */
export function parseHtmlTable(html) {
  const rows = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let r;
  while ((r = rowRe.exec(html))) {
    const cells = [];
    const cellRe = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/g;
    let c;
    let header = false;
    while ((c = cellRe.exec(r[1]))) {
      if (c[1] === 'th') header = true;
      cells.push(plain(c[2]));
    }
    if (cells.length) rows.push({ header, cells });
  }
  return rows;
}

/** Find every <table>...</table> block in a chunk of Markdown. */
export function findTables(markdown) {
  return [...markdown.matchAll(/<table>[\s\S]*?<\/table>/g)].map((m) => m[0]);
}

/**
 * Split a block of "**_Name._** text" paragraphs (monster traits/actions,
 * species traits written as "_Name._ text") into [{ name, text }].
 * Continuation paragraphs (no leading name) are appended to the previous entry.
 */
export function namedParagraphs(body) {
  const items = [];
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && p !== '<hr>');
  for (const p of paras) {
    const m = p.match(/^(?:\*\*_|_\*\*|_)([^_*]+?)\.?(?:_\*\*|\*\*_|_)\s+([\s\S]*)$/);
    if (m) items.push({ name: m[1].replace(/\.$/, '').trim(), text: cleanText(m[2]) });
    else if (items.length) items[items.length - 1].text += '\n\n' + cleanText(p);
    else items.push({ name: '', text: cleanText(p) });
  }
  return items;
}

/** Light cleanup of description text: keep Markdown emphasis, drop HTML line breaks. */
export function cleanText(text) {
  return text
    .replace(/\s*<br\s*\/?>\s*\n?\s*&emsp;/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&emsp;/g, '')
    .trim();
}

/** Parse "1d8 + 3" style dice expressions found in text. */
export function findDice(text) {
  return [...text.matchAll(/(\d+)\s*\((\d+d\d+(?:\s*[+−-]\s*\d+)?)\)\s*([A-Z][a-z]+)?/g)].map((m) => ({
    average: Number(m[1]),
    dice: m[2].replace(/\s+/g, '').replace('−', '-'),
    type: m[3] || null,
  }));
}

/** Convert "+5" / "−1" (with a real minus sign) to a number. */
export function signedNumber(s) {
  if (s == null) return null;
  const n = Number(String(s).replace('−', '-').replace('+', '').trim());
  return Number.isFinite(n) ? n : null;
}
