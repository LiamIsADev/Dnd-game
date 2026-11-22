// Small pure helpers for the live table, kept separate so they can be tested.

/** How many squares across a creature takes up on the grid (2024 rules sizes). */
export function squaresForSize(size) {
  const s = Array.isArray(size) ? size[0] : size;
  return { Large: 2, Huge: 3, Gargantuan: 4 }[s] || 1;
}

export function initials(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Turn a dice roll row from the database into text like "1d20 (17) + 5". */
export function describeRoll(row) {
  const parts = Array.isArray(row?.detail) ? row.detail : [];
  return parts
    .map((p, i) => {
      const sign = p.sign < 0 ? '− ' : i ? '+ ' : '';
      if (p.dice) {
        const kept = [...(p.kept || [])];
        const shown = p.dice.map((d) => {
          const k = kept.indexOf(d);
          if (k >= 0) {
            kept.splice(k, 1);
            return String(d);
          }
          return `~~${d}~~`;
        });
        return `${sign}${p.dice.length}d${p.sides} (${shown.join(', ')})`;
      }
      return `${sign}${p.value}`;
    })
    .join(' ');
}

/** Clean up what someone typed into the dice box: "2D6 + 3" -> "2d6+3". */
export function cleanDice(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

export const DICE_PATTERN = /^[+-]?(\d*d\d+(kh\d+)?|\d+)([+-](\d*d\d+(kh\d+)?|\d+))*$/;

export function isValidDice(text) {
  const t = cleanDice(text);
  return t.length > 0 && t.length <= 60 && DICE_PATTERN.test(t);
}

/** "+5" / "-1" for adding a modifier to a dice expression. */
export function withMod(dice, mod) {
  if (!mod) return dice;
  return `${dice}${mod > 0 ? '+' : '-'}${Math.abs(mod)}`;
}

export const TOKEN_COLORS = ['#8b2c2c', '#2c5d8b', '#2f7a46', '#7a5a2c', '#6b3f8b', '#2c7a7a', '#555555', '#b06a1c'];

export function inviteLink(code, base = typeof location !== 'undefined' ? location.origin + location.pathname : '') {
  return `${base}#/join/${code}`;
}
