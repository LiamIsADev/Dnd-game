// Digital dice. Uses the browser's cryptographic random number generator so
// rolls are fair and can't be predicted.

/** Roll one die with `sides` faces (1..sides). */
export function rollDie(sides, rng = secureRandom) {
  if (!Number.isInteger(sides) || sides < 1) throw new Error(`Invalid die: d${sides}`);
  return 1 + Math.floor(rng() * sides);
}

function secureRandom() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

/**
 * Parse an expression such as "1d20+5", "2d6 + 3", "d8", "4d6kh3" or "8".
 * Returns a list of terms: { count, sides, sign, keepHighest } or { value, sign }.
 */
export function parseDice(expr) {
  const clean = String(expr).replace(/\s+/g, '').replace(/−/g, '-').toLowerCase();
  if (!clean) throw new Error('Empty dice expression');
  const terms = [];
  const re = /([+-]?)(?:(\d*)d(\d+)(?:kh(\d+))?|(\d+))/gy;
  let m;
  let consumed = 0;
  while (consumed < clean.length && (m = re.exec(clean))) {
    const sign = m[1] === '-' ? -1 : 1;
    if (m[3]) {
      const count = m[2] ? Number(m[2]) : 1;
      if (count > 100) throw new Error('Too many dice');
      terms.push({ count, sides: Number(m[3]), sign, keepHighest: m[4] ? Number(m[4]) : null });
    } else {
      terms.push({ value: Number(m[5]), sign });
    }
    consumed = re.lastIndex;
  }
  if (consumed !== clean.length || !terms.length) throw new Error(`Can't read dice expression "${expr}"`);
  return terms;
}

/**
 * Roll an expression. Options:
 *   mode: 'normal' | 'advantage' | 'disadvantage' (applies to a single d20 term)
 * Returns { expr, total, parts: [{ dice:[...], kept:[...], sides, sign } | { value, sign }], natural }
 * `natural` is the kept d20 face when the expression has exactly one d20, for spotting 1s and 20s.
 */
export function roll(expr, { mode = 'normal', rng } = {}) {
  const terms = parseDice(expr);
  const parts = [];
  let total = 0;
  let natural = null;
  const d20s = terms.filter((t) => t.sides === 20 && t.count === 1);
  for (const t of terms) {
    if (t.value != null) {
      parts.push({ value: t.value, sign: t.sign });
      total += t.sign * t.value;
      continue;
    }
    let count = t.count;
    let keep = t.keepHighest;
    let keepLowest = null;
    const isAdvTarget = t.sides === 20 && t.count === 1 && d20s.length === 1 && mode !== 'normal';
    if (isAdvTarget) {
      count = 2;
      if (mode === 'advantage') keep = 1;
      else keepLowest = 1;
    }
    const dice = Array.from({ length: count }, () => rollDie(t.sides, rng));
    let kept = dice;
    if (keep != null) kept = [...dice].sort((a, b) => b - a).slice(0, keep);
    if (keepLowest != null) kept = [...dice].sort((a, b) => a - b).slice(0, keepLowest);
    const sum = kept.reduce((a, b) => a + b, 0);
    total += t.sign * sum;
    if (t.sides === 20 && d20s.length === 1 && t === d20s[0]) natural = kept[0];
    parts.push({ dice, kept, sides: t.sides, sign: t.sign });
  }
  return { expr: String(expr), mode, total, parts, natural };
}

/** Double the dice of a damage expression for a Critical Hit ("1d8+3" -> "2d8+3"). */
export function critical(expr) {
  return parseDice(expr)
    .map((t, i) => {
      const sign = t.sign < 0 ? '-' : i === 0 ? '' : '+';
      return t.value != null ? `${sign}${t.value}` : `${sign}${t.count * 2}d${t.sides}`;
    })
    .join('');
}

/** Build "1d20+5" style text from a modifier. */
export function d20(mod) {
  return mod ? `1d20${mod > 0 ? '+' : '-'}${Math.abs(mod)}` : '1d20';
}

/** Human-readable breakdown: "[14, 3] + 5". */
export function describe(result) {
  return result.parts
    .map((p, i) => {
      const sign = p.sign < 0 ? '− ' : i === 0 ? '' : '+ ';
      if (p.value != null) return `${sign}${p.value}`;
      const shown = p.dice.length === p.kept.length ? p.dice.join(', ') : p.dice.map((d) => d).join(', ') + ` → ${p.kept.join(', ')}`;
      return `${sign}[${shown}]`;
    })
    .join(' ');
}
