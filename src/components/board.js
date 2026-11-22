// The grid battle map: background image, grid lines, fog of war and tokens.
// Works with a mouse, a pen or a finger. The page owns the data; this file
// only draws it and reports what the person did.
import { esc } from '../lib/dom.js';
import { fitFog, circleCells, setCells } from '../lib/campaign/fog.js';
import { initials } from '../lib/campaign/util.js';

const BASE_CELL = 40;
export const DRAG_TYPE = 'application/x-dnd-token';

/**
 * @param {HTMLElement} host
 * @param {object} opts
 *   isDm, onMove(token, x, y), onSelect(token | null), onDrop(payload, x, y),
 *   onCellClick(x, y), onFogPaint(cells, revealed)
 */
export function createBoard(host, opts) {
  host.innerHTML = `
    <div class="board-scroll" tabindex="0" aria-label="Battle map">
      <div class="board">
        <img class="board-bg" alt="" hidden>
        <div class="board-grid"></div>
        <canvas class="board-fog"></canvas>
        <div class="board-tokens"></div>
        <div class="board-brush" hidden></div>
      </div>
    </div>
    <p class="board-empty" hidden></p>`;
  const scroll = host.querySelector('.board-scroll');
  const board = host.querySelector('.board');
  const bg = host.querySelector('.board-bg');
  const grid = host.querySelector('.board-grid');
  const fogCanvas = host.querySelector('.board-fog');
  const layer = host.querySelector('.board-tokens');
  const brushEl = host.querySelector('.board-brush');
  const emptyEl = host.querySelector('.board-empty');

  let state = { map: null, tokens: [], background: null, selectedId: null, canMove: () => false, pending: null };
  let zoom = 1;
  let tool = 'move'; // 'move' | 'reveal' | 'hide'
  let brush = 1;
  let drag = null;
  let paint = null;

  const cell = () => Math.round(BASE_CELL * zoom);

  function cellAt(e) {
    const r = board.getBoundingClientRect();
    const c = cell();
    return [Math.floor((e.clientX - r.left) / c), Math.floor((e.clientY - r.top) / c)];
  }

  function inBounds(x, y) {
    const m = state.map;
    return m && x >= 0 && y >= 0 && x < m.cols && y < m.rows;
  }

  /* ---------------------------------------------------------- drawing */
  function drawAll() {
    const m = state.map;
    emptyEl.hidden = !!m;
    scroll.hidden = !m;
    if (!m) {
      emptyEl.textContent = state.emptyText || 'No map yet.';
      return;
    }
    const c = cell();
    board.style.width = `${m.cols * c}px`;
    board.style.height = `${m.rows * c}px`;
    board.style.setProperty('--cell', `${c}px`);
    board.dataset.tool = opts.isDm ? tool : 'move';
    board.classList.toggle('placing', !!state.pending);
    if (state.background) {
      if (bg.getAttribute('src') !== state.background) bg.src = state.background;
      bg.hidden = false;
    } else {
      bg.hidden = true;
      bg.removeAttribute('src');
    }
    grid.hidden = false;
    drawFog(paint?.fog);
    drawTokens();
  }

  function drawFog(override) {
    const m = state.map;
    if (!m) return;
    const c = cell();
    const dpr = window.devicePixelRatio || 1;
    fogCanvas.width = m.cols * c * dpr;
    fogCanvas.height = m.rows * c * dpr;
    fogCanvas.style.width = `${m.cols * c}px`;
    fogCanvas.style.height = `${m.rows * c}px`;
    const ctx = fogCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.cols * c, m.rows * c);
    const fog = override || fitFog(m.revealed, m.cols, m.rows);
    // Players get solid darkness; the DM sees through it, shaded.
    ctx.fillStyle = opts.isDm ? 'rgba(12, 14, 24, 0.5)' : '#0c0e18';
    for (let y = 0; y < m.rows; y++) {
      for (let x = 0; x < m.cols; x++) {
        if (fog[y * m.cols + x] !== '1') ctx.fillRect(x * c, y * c, c + 0.5, c + 0.5);
      }
    }
  }

  function drawTokens() {
    const c = cell();
    const m = state.map;
    const html = state.tokens
      .filter((t) => t.map_id === m.id)
      .map((t) => {
        const x = drag?.token.id === t.id ? drag.x : t.x;
        const y = drag?.token.id === t.id ? drag.y : t.y;
        const cls = ['token', t.kind, t.hidden ? 'is-hidden' : '', state.selectedId === t.id ? 'selected' : '', state.canMove(t) ? 'movable' : '', drag?.token.id === t.id ? 'dragging' : '']
          .filter(Boolean)
          .join(' ');
        const hp = state.hpFor?.(t);
        const hpBar = hp && hp.max ? `<span class="token-hp" style="--hp:${Math.max(0, Math.min(1, hp.current / hp.max))}"></span>` : '';
        return `<button type="button" class="${cls}" data-token="${esc(t.id)}"
            style="left:${x * c}px;top:${y * c}px;width:${t.size * c}px;height:${t.size * c}px;--token:${esc(t.color)}"
            title="${esc(t.name)}${t.hidden ? ' (hidden from players)' : ''}" aria-label="${esc(t.name)}">
            <span class="token-face">${esc(initials(t.name))}</span>${hpBar}
            <span class="token-name">${esc(t.name)}</span>
          </button>`;
      })
      .join('');
    layer.innerHTML = html;
  }

  /* ------------------------------------------------------- interaction */
  function tokenFrom(e) {
    const el = e.target.closest?.('[data-token]');
    return el ? state.tokens.find((t) => t.id === el.dataset.token) : null;
  }

  board.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.map) return;
    const [x, y] = cellAt(e);
    if (opts.isDm && tool !== 'move' && !state.pending) {
      paint = { revealed: tool === 'reveal', cells: [], fog: fitFog(state.map.revealed, state.map.cols, state.map.rows) };
      board.setPointerCapture(e.pointerId);
      paintAt(x, y);
      e.preventDefault();
      return;
    }
    const t = tokenFrom(e);
    if (t && state.canMove(t) && !state.pending) {
      drag = { token: t, x: t.x, y: t.y, startX: e.clientX, startY: e.clientY, offX: x - t.x, offY: y - t.y, moved: false };
      board.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });

  board.addEventListener('pointermove', (e) => {
    if (!state.map) return;
    const [x, y] = cellAt(e);
    if (opts.isDm && tool !== 'move') showBrush(x, y);
    if (paint) {
      paintAt(x, y);
      return;
    }
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
    drag.moved = true;
    const m = state.map;
    const nx = Math.max(0, Math.min(m.cols - drag.token.size, x - drag.offX));
    const ny = Math.max(0, Math.min(m.rows - drag.token.size, y - drag.offY));
    if (nx !== drag.x || ny !== drag.y) {
      drag.x = nx;
      drag.y = ny;
      const el = layer.querySelector(`[data-token="${CSS.escape(drag.token.id)}"]`);
      if (el) {
        el.style.left = `${nx * cell()}px`;
        el.style.top = `${ny * cell()}px`;
        el.classList.add('dragging');
      }
    }
  });

  board.addEventListener('pointerleave', () => {
    brushEl.hidden = true;
  });

  function finishPointer(e, cancelled) {
    if (paint) {
      const p = paint;
      paint = null;
      if (!cancelled && p.cells.length) opts.onFogPaint?.(p.cells, p.revealed);
      else drawFog();
      return;
    }
    if (drag) {
      const d = drag;
      drag = null;
      if (cancelled) return drawTokens();
      if (d.moved && (d.x !== d.token.x || d.y !== d.token.y)) opts.onMove?.(d.token, d.x, d.y);
      else {
        drawTokens();
        if (!d.moved) opts.onSelect?.(d.token);
      }
    }
  }
  board.addEventListener('pointerup', (e) => finishPointer(e, false));
  board.addEventListener('pointercancel', (e) => finishPointer(e, true));

  // Clicks that weren't drags: selecting a token, or placing / clicking a square.
  board.addEventListener('click', (e) => {
    if (!state.map) return;
    if (opts.isDm && tool !== 'move' && !state.pending) return;
    const [x, y] = cellAt(e);
    const t = tokenFrom(e);
    if (state.pending) {
      if (inBounds(x, y)) opts.onCellClick?.(x, y);
      return;
    }
    if (t) {
      if (!state.canMove(t)) opts.onSelect?.(t);
      return;
    }
    if (inBounds(x, y)) opts.onCellClick?.(x, y);
    opts.onSelect?.(null);
  });

  function paintAt(x, y) {
    const m = state.map;
    const cells = circleCells(x, y, brush - 1, m.cols, m.rows);
    paint.cells.push(...cells);
    paint.fog = setCells(paint.fog, m.cols, m.rows, cells, paint.revealed);
    drawFog(paint.fog);
  }

  function showBrush(x, y) {
    if (!inBounds(x, y)) {
      brushEl.hidden = true;
      return;
    }
    const c = cell();
    const r = brush - 1;
    brushEl.hidden = false;
    brushEl.style.left = `${(x - r) * c}px`;
    brushEl.style.top = `${(y - r) * c}px`;
    brushEl.style.width = brushEl.style.height = `${(2 * r + 1) * c}px`;
  }

  // Drag and drop from the DM's enemy list or party list onto the map.
  board.addEventListener('dragover', (e) => {
    if (!opts.isDm || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const [x, y] = cellAt(e);
    tool === 'move' && highlightDrop(x, y);
  });
  board.addEventListener('dragleave', () => (brushEl.hidden = true));
  board.addEventListener('drop', (e) => {
    if (!opts.isDm) return;
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    brushEl.hidden = true;
    const [x, y] = cellAt(e);
    if (!inBounds(x, y)) return;
    try {
      opts.onDrop?.(JSON.parse(raw), x, y);
    } catch {
      /* not one of ours */
    }
  });

  function highlightDrop(x, y) {
    if (!inBounds(x, y)) return;
    const c = cell();
    brushEl.hidden = false;
    brushEl.style.left = `${x * c}px`;
    brushEl.style.top = `${y * c}px`;
    brushEl.style.width = brushEl.style.height = `${c}px`;
  }

  return {
    update(next) {
      state = { ...state, ...next };
      // Don't yank a token out from under someone's finger mid-drag.
      if (drag && !state.tokens.some((t) => t.id === drag.token.id)) drag = null;
      if (paint) return drawTokens();
      drawAll();
    },
    setTool(next) {
      tool = next;
      brushEl.hidden = true;
      drawAll();
    },
    setBrush(n) {
      brush = n;
    },
    zoomBy(f) {
      const before = zoom;
      zoom = Math.max(0.4, Math.min(2.5, Math.round(zoom * f * 100) / 100));
      if (zoom !== before) {
        const cx = (scroll.scrollLeft + scroll.clientWidth / 2) / before;
        const cy = (scroll.scrollTop + scroll.clientHeight / 2) / before;
        drawAll();
        scroll.scrollLeft = cx * zoom - scroll.clientWidth / 2;
        scroll.scrollTop = cy * zoom - scroll.clientHeight / 2;
      }
      return zoom;
    },
    /** Scroll so a square is in view (e.g. the player's own token). */
    centerOn(x, y) {
      const c = cell();
      scroll.scrollLeft = x * c - scroll.clientWidth / 2;
      scroll.scrollTop = y * c - scroll.clientHeight / 2;
    },
  };
}
