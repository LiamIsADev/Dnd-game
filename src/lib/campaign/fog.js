// Fog of war is stored as one character per square, row by row:
// '1' = revealed, '0' = still hidden. These helpers match the database's
// reveal_circle() so the DM's brush and players' movement agree.

export function emptyFog(cols, rows) {
  return '0'.repeat(cols * rows);
}

/** Make sure a fog string is exactly the right length for the map. */
export function fitFog(fog, cols, rows) {
  const n = cols * rows;
  const s = String(fog || '').replace(/[^01]/g, '0');
  return s.length >= n ? s.slice(0, n) : s + '0'.repeat(n - s.length);
}

export function isRevealed(fog, cols, rows, x, y) {
  if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
  return fog[y * cols + x] === '1';
}

/** Squares within `radius` of (cx, cy), the same circle the database uses. */
export function circleCells(cx, cy, radius, cols, rows) {
  const out = [];
  for (let y = Math.max(0, cy - radius); y <= Math.min(rows - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(cols - 1, cx + radius); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) out.push([x, y]);
    }
  }
  return out;
}

/** Return a new fog string with the given squares set to revealed (true) or hidden (false). */
export function setCells(fog, cols, rows, cells, revealed = true) {
  const arr = fitFog(fog, cols, rows).split('');
  const v = revealed ? '1' : '0';
  for (const [x, y] of cells) {
    if (x >= 0 && y >= 0 && x < cols && y < rows) arr[y * cols + x] = v;
  }
  return arr.join('');
}

export function paintCircle(fog, cols, rows, cx, cy, radius, revealed = true) {
  return setCells(fog, cols, rows, circleCells(cx, cy, radius, cols, rows), revealed);
}

export function countRevealed(fog) {
  let n = 0;
  for (const ch of fog) if (ch === '1') n++;
  return n;
}
