// Spell areas on the grid: where a Fireball's sphere, a Burning Hands cone,
// a Lightning Bolt line or a Thunderwave cube lands, and who is inside.
// Everything is measured in squares (1 square = 5 feet). Points are in
// square units too: (0, 0) is the map's top-left corner, (0.5, 0.5) the
// middle of the first square.

export const FEET_PER_SQUARE = 5;

// A cone is as wide as it is far from its point: half-angle atan(1/2).
const CONE_COS = Math.cos(Math.atan(0.5) + 0.03);

/**
 * Turn a spell's area ({shape, size, width, self} in feet, from spellArea())
 * into a shape on the map, aimed at a point.
 * @param spellArea from automation.spellArea
 * @param caster the casting token {x, y, size}, for areas that start at the caster
 * @param at the point aimed at, in squares
 * @returns circle {x, y, r} · cube {x, y, n} (top-left square, side) ·
 *   cone {x, y, dx, dy, len} · line {x, y, dx, dy, len, w}
 */
export function areaGeometry(spellArea, caster, at) {
  const sq = spellArea.size / FEET_PER_SQUARE;
  const half = caster ? caster.size / 2 : 0;
  const cx = caster ? caster.x + half : at.x;
  const cy = caster ? caster.y + half : at.y;
  const base = { shape: spellArea.shape, feet: spellArea.size };
  if (spellArea.shape === 'circle') {
    // From the caster (an Emanation) it reaches out from the caster's edge;
    // otherwise it's centred on the nearest grid corner.
    if (spellArea.self && caster) return { ...base, x: cx, y: cy, r: sq + half };
    return { ...base, x: Math.round(at.x), y: Math.round(at.y), r: sq };
  }
  if (spellArea.shape === 'cube') {
    const n = Math.max(1, Math.round(sq));
    if (spellArea.self && caster) {
      // Touching the caster, on the side (or corner) facing the cursor.
      const ang = Math.atan2(at.y - cy, at.x - cx);
      const dir = Math.round(ang / (Math.PI / 4));
      const dx = Math.round(Math.cos((dir * Math.PI) / 4));
      const dy = Math.round(Math.sin((dir * Math.PI) / 4));
      const x = dx > 0 ? caster.x + caster.size : dx < 0 ? caster.x - n : caster.x + Math.floor((caster.size - n) / 2);
      const y = dy > 0 ? caster.y + caster.size : dy < 0 ? caster.y - n : caster.y + Math.floor((caster.size - n) / 2);
      return { ...base, x, y, n };
    }
    return { ...base, x: Math.floor(at.x) - Math.floor((n - 1) / 2), y: Math.floor(at.y) - Math.floor((n - 1) / 2), n };
  }
  // Cones and lines start at the caster and point at the cursor.
  let dx = at.x - cx;
  let dy = at.y - cy;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  if (d < 0.01) dx = 1;
  if (spellArea.shape === 'cone') return { ...base, x: cx, y: cy, dx, dy, len: sq + half };
  return { ...base, shape: 'line', x: cx, y: cy, dx, dy, len: sq + half, w: (spellArea.width || 5) / FEET_PER_SQUARE };
}

/** Is the middle of square (x, y) inside an area? */
export function cellInArea(a, x, y) {
  const px = x + 0.5;
  const py = y + 0.5;
  if (a.shape === 'circle') return Math.hypot(px - a.x, py - a.y) <= a.r + 0.01;
  if (a.shape === 'cube') return x >= a.x && x < a.x + a.n && y >= a.y && y < a.y + a.n;
  const vx = px - a.x;
  const vy = py - a.y;
  const along = vx * a.dx + vy * a.dy;
  if (a.shape === 'cone') {
    const dist = Math.hypot(vx, vy);
    return dist > 0.01 && dist <= a.len + 0.01 && along / dist >= CONE_COS;
  }
  if (a.shape === 'line') {
    const across = Math.abs(-vx * a.dy + vy * a.dx);
    return along >= 0 && along <= a.len + 0.01 && across <= a.w / 2 + 0.2;
  }
  return false;
}

/** The tokens with at least one square inside the area (leaving out the caster). */
export function tokensInArea(a, tokens, casterId) {
  return tokens.filter((t) => {
    if (t.id === casterId) return false;
    for (let y = t.y; y < t.y + t.size; y++) for (let x = t.x; x < t.x + t.size; x++) if (cellInArea(a, x, y)) return true;
    return false;
  });
}

/** Rounded copy small enough to store with the roll. */
export function packArea(a, mapId) {
  const r = (n) => Math.round(n * 100) / 100;
  const out = { map: mapId };
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === 'number' ? r(v) : v;
  return out;
}
