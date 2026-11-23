// The live table: #/campaigns/:id
// The DM gets enemies, maps, images and every token. Players get the active
// map (through the fog), their own character and anything the DM has shown.
import { html, raw, debounce } from '../lib/dom.js';
import { getAuth } from '../lib/auth.js';
import { loadSrd, loadCharacterRules, formatMod, ABILITY_NAMES, spellLevelLabel } from '../lib/srd.js';
import { toast, confirmDialog } from '../lib/ui.js';
import { roll as localRoll } from '../lib/dice.js';
import { derive, SKILLS } from '../lib/character/rules.js';
import { listCharacters } from '../lib/character/store.js';
import {
  monsterSecrets, characterSecrets, monsterActions, castableSpells, spellMechanics, CONDITIONS, combatStats, classBonusActions, walkSpeed,
} from '../lib/character/automation.js';
import { tokensInArea, packArea } from '../lib/campaign/areas.js';
import { statBlock } from '../components/statblock.js';
import { createBoard, DRAG_TYPE } from '../components/board.js';
import { fitFog, setCells, countRevealed } from '../lib/campaign/fog.js';
import { squaresForSize, describeRoll, cleanDice, isValidDice, withMod, TOKEN_COLORS, inviteLink } from '../lib/campaign/util.js';
import * as store from '../lib/campaign/store.js';

const PC_COLOR = '#2c5d8b';

export async function renderTable(root, { params, navigate }) {
  const [campaignId] = params;
  const me = getAuth().session.user.id;
  root.innerHTML = '<p class="loading">Opening the table…</p>';

  let s = await store.loadTable(campaignId, me);
  if (!s) {
    root.innerHTML = String(html`<section class="page narrow"><div class="card">
      <h1>Campaign not found</h1>
      <p>This campaign doesn't exist, or you aren't in it. Ask your DM for the invite link or code.</p>
      <p><a class="button" href="#/campaigns">Back to campaigns</a></p></div></section>`);
    return;
  }
  const isDm = s.isDm;
  const [rules, monsters] = await Promise.all([loadCharacterRules(), isDm ? loadSrd('monsters') : Promise.resolve([])]);

  const ui = {
    tab: isDm ? 'enemies' : 'character',
    viewMapId: null, // the DM can prepare a map before opening it for players
    selectedId: null,
    pending: null, // something the DM is about to place with a click
    tool: 'move',
    brush: 1,
    search: '',
    spawnHidden: true,
    rollHp: false,
    rollMode: 'normal',
    secret: false,
    myCharacters: null,
    seenHandouts: new Map(),
    live: 'connecting',
    gone: false,
    target: null, // choosing who an attack or spell hits
    aim: null, // aiming an area spell: {area, label, run}
    areas: [], // area spells just cast, shown on the map for a while
    lastTurn: null,
  };
  // Handouts already up when the page opens don't pop up again.
  for (const h of s.handouts) if (h.shown) ui.seenHandouts.set(h.id, h.shown_at);

  /* ------------------------------------------------------------ helpers */
  const activeMap = () => s.maps.find((m) => m.id === s.campaign.active_map_id) || null;
  const viewMap = () => (isDm ? s.maps.find((m) => m.id === ui.viewMapId) || activeMap() || s.maps[0] || null : activeMap());
  const member = (userId) => s.members.find((m) => m.user_id === userId);
  const myMember = () => member(me);
  const myCharacter = () => s.characters[myMember()?.character_id] || null;
  const selected = () => s.tokens.find((t) => t.id === ui.selectedId) || null;
  const monsterById = (id) => monsters.find((m) => m.id === id);
  const canMove = (t) => isDm || t.owner_id === me;
  const busy = new Set();

  function hpFor(t) {
    if (isDm && s.secrets[t.id]?.hp_max) return { current: s.secrets[t.id].hp_current ?? 0, max: s.secrets[t.id].hp_max };
    if (t.kind === 'pc' && t.character_id && s.characters[t.character_id]) {
      const c = s.characters[t.character_id];
      const d = derive(c.data, rules);
      return { current: c.data.hp?.current ?? d.hpMax, max: d.hpMax };
    }
    return null;
  }

  async function guard(fn, okMessage) {
    try {
      const out = await fn();
      if (okMessage) toast(okMessage, 'success');
      return out;
    } catch (err) {
      console.error(err);
      toast(err.message, 'error');
      return undefined;
    }
  }

  /* ------------------------------------------------------------- layout */
  root.innerHTML = String(html`
    <section class="table-page">
      <header class="table-head">
        <div>
          <p class="eyebrow">${isDm ? 'You are the Dungeon Master' : 'Player'}</p>
          <h1 class="table-title"></h1>
        </div>
        <div class="table-head-actions">
          <span class="live-dot" role="status" aria-live="polite"></span>
          ${isDm ? html`<button type="button" class="button small secondary" data-act="invite">Invite players</button>` : ''}
          <a class="button small secondary" href="#/campaigns">All campaigns</a>
        </div>
      </header>
      <div class="table-layout">
        <div class="table-main">
          <div class="combat-bar" aria-live="polite"></div>
          <div class="board-toolbar"></div>
          <div class="board-host"></div>
        </div>
        <aside class="table-side">
          <nav class="tabs" role="tablist"></nav>
          <div class="tab-body"></div>
        </aside>
        <section class="dice-panel card" aria-label="Dice">
          <form class="dice-form">
            <div class="dice-quick">
              ${[4, 6, 8, 10, 12, 20, 100].map((n) => html`<button type="button" class="die" data-act="quick-die" data-die="${n}">d${n}</button>`)}
            </div>
            <div class="dice-row">
              <label class="sr-only" for="dice-expr">Dice to roll</label>
              <input id="dice-expr" name="expr" placeholder="e.g. 1d20+5 or 2d6+3" autocomplete="off" maxlength="60">
              <button class="button">Roll</button>
            </div>
            <div class="dice-row options">
              <div class="segmented mode-buttons" role="group" aria-label="Advantage">
                <button type="button" data-mode="disadvantage">Disadvantage</button>
                <button type="button" data-mode="normal">Normal</button>
                <button type="button" data-mode="advantage">Advantage</button>
              </div>
              <label class="check"><input type="checkbox" name="secret"> ${isDm ? 'Secret (only me)' : 'Only me and the DM'}</label>
            </div>
          </form>
          <h2 class="log-title">Roll log</h2>
          <ol class="roll-log" aria-live="polite"></ol>
        </section>
      </div>
    </section>`);

  const els = {
    title: root.querySelector('.table-title'),
    live: root.querySelector('.live-dot'),
    toolbar: root.querySelector('.board-toolbar'),
    combat: root.querySelector('.combat-bar'),
    tabs: root.querySelector('.tabs'),
    body: root.querySelector('.tab-body'),
    log: root.querySelector('.roll-log'),
    diceForm: root.querySelector('.dice-form'),
  };

  const board = createBoard(root.querySelector('.board-host'), {
    isDm,
    onMove: moveToken,
    onSelect(t) {
      if (ui.target) {
        if (t) pickTarget(t);
        return;
      }
      ui.selectedId = t?.id || null;
      if (t && isDm) ui.tab = 'token';
      drawBoard();
      drawSide();
    },
    onDrop: spawn,
    onCellClick(x, y) {
      if (ui.target) return;
      if (ui.pending) {
        const p = ui.pending;
        ui.pending = null;
        spawn(p, x, y);
      }
    },
    onFogPaint: paintFog,
    onAim: placeArea,
    onMoveRefused(t, message) {
      toast(message, 'error');
    },
  });

  /* -------------------------------------------------------------- drawing */
  function drawAll() {
    els.title.textContent = s.campaign.name;
    drawLive();
    drawCombat();
    drawToolbar();
    drawBoard();
    drawSide();
    drawLog();
    drawMode();
  }

  function drawLive() {
    const ok = ui.live === 'SUBSCRIBED';
    els.live.className = `live-dot ${ok ? 'on' : ''}`;
    els.live.textContent = ok ? 'Live' : 'Connecting…';
  }

  async function drawBoard() {
    const m = viewMap();
    const bgUrl = m?.background_path ? await store.imageUrl(m.background_path) : null;
    board.update({
      map: m,
      tokens: s.tokens,
      background: bgUrl,
      selectedId: ui.selectedId,
      canMove,
      hpFor,
      pending: ui.pending,
      activeId: s.campaign.combat_round != null ? s.campaign.combat_turn : null,
      targetIds: new Set(ui.target?.targets || []),
      targeting: !!ui.target,
      moveInfo,
      aim: ui.aim ? { ...ui.aim.area, caster: ui.aim.caster } : null,
      areas: recentAreas(),
      emptyText: isDm ? 'Create a map in the Maps tab.' : "The DM hasn't opened a map yet. Hang tight!",
    });
  }

  function drawToolbar() {
    const m = viewMap();
    const active = activeMap();
    const preparing = isDm && m && active?.id !== m.id;
    els.toolbar.innerHTML = String(html`
      <div class="toolbar-group">
        <button type="button" class="button small secondary" data-act="zoom-out" aria-label="Zoom out">−</button>
        <button type="button" class="button small secondary" data-act="zoom-in" aria-label="Zoom in">+</button>
        ${!isDm && s.tokens.some((t) => t.owner_id === me) ? html`<button type="button" class="button small secondary" data-act="find-me">Find my token</button>` : ''}
      </div>
      ${isDm && m
        ? html`<div class="toolbar-group segmented" role="group" aria-label="Map tool">
              ${[
                ['move', 'Move'],
                ['reveal', 'Reveal fog'],
                ['hide', 'Add fog'],
              ].map(([v, l]) => html`<button type="button" data-tool="${v}" aria-pressed="${ui.tool === v}">${l}</button>`)}
            </div>
            ${ui.tool !== 'move'
              ? html`<label class="toolbar-group">Brush
                  <select data-act="brush">${[1, 2, 3, 5].map((n) => html`<option value="${n}" ${ui.brush === n ? raw('selected') : ''}>${n === 1 ? '1 square' : `${n * 2 - 1} wide`}</option>`)}</select></label>`
              : ''}`
        : ''}
      <div class="toolbar-group grow"></div>
      ${ui.target
        ? html`<p class="toolbar-note warn">${ui.target.multi
            ? html`${targetPrompt(ui.target)}
                <button type="button" class="button small" data-act="confirm-targets" ${ui.target.targets.length || ui.target.area ? '' : raw('disabled')}>${ui.target.label}</button>
                ${ui.target.repeat && ui.target.targets.length ? html`<button type="button" class="link-button" data-act="undo-target">Undo last</button>` : ''}`
            : html`Click the target for <strong>${ui.target.label}</strong>.`}
            <button type="button" class="link-button" data-act="cancel-target">Cancel</button></p>`
        : ''}
      ${ui.aim
        ? html`<p class="toolbar-note warn">Aim <strong>${ui.aim.label.replace(/^Cast /, '')}</strong> (${ui.aim.area.size}-foot ${AREA_NAMES[ui.aim.area.shape]}): move over the map and click to place it.
            <button type="button" class="link-button" data-act="cancel-aim">Cancel</button></p>`
        : ''}
      ${ui.pending ? html`<p class="toolbar-note">Click a square to place <strong>${ui.pending.name}</strong>. <button type="button" class="link-button" data-act="cancel-place">Cancel</button></p>` : ''}
      ${preparing ? html`<p class="toolbar-note warn">Preparing <strong>${m.name}</strong>. Players can't see it. <button type="button" class="button small" data-act="activate-map" data-id="${m.id}">Open for players</button></p>` : ''}
      ${isDm && m && !preparing ? html`<p class="toolbar-note">Players see: <strong>${m.name}</strong></p>` : ''}`);
  }

  /* --------------------------------------------------------------- combat */
  const myToken = () => {
    const m = activeMap();
    return s.tokens.find((t) => t.owner_id === me && m && t.map_id === m.id) || null;
  };
  const turnOrder = () => {
    const m = activeMap();
    return s.tokens
      .filter((t) => m && t.map_id === m.id && t.initiative != null)
      .sort((a, b) => b.initiative - a.initiative || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  };

  function drawCombat() {
    const c = s.campaign;
    const active = c.combat_round != null;
    if (!active) {
      els.combat.hidden = !isDm;
      els.combat.innerHTML = isDm
        ? String(html`<div class="combat-head"><button type="button" class="button small" data-act="combat-start">⚔ Start combat</button>
            <span class="muted small">Everyone rolls initiative and the site tracks whose turn it is.</span></div>`)
        : '';
      return;
    }
    const current = s.tokens.find((t) => t.id === c.combat_turn);
    const mine = myToken();
    els.combat.hidden = false;
    els.combat.innerHTML = String(html`
      <div class="combat-head">
        <strong>Round ${c.combat_round}</strong>
        <span>${current ? (current.owner_id === me ? html`<strong class="your-turn">Your turn!</strong>` : html`${current.name}’s turn`) : c.combat_turn ? 'Something unseen is acting…' : 'Roll for initiative!'}</span>
        <span class="grow"></span>
        ${isDm
          ? html`<button type="button" class="button small secondary" data-act="init-enemies">Roll initiative for enemies</button>
              <button type="button" class="button small" data-act="next-turn">${c.combat_turn ? 'Next turn →' : 'Start first turn'}</button>
              <button type="button" class="link-button small" data-act="combat-end">End combat</button>`
          : html`${mine && mine.initiative == null ? html`<button type="button" class="button small" data-act="my-initiative">Roll initiative</button>` : ''}
              ${current && current.owner_id === me ? html`<button type="button" class="button small" data-act="next-turn">End my turn</button>` : ''}`}
      </div>
      ${economyBar(current, mine)}
      <ol class="turn-order">
        ${turnOrder().map(
          (t) => html`<li class="${t.id === c.combat_turn ? 'current' : ''} ${t.conditions?.includes('Dead') ? 'dead' : ''} ${t.kind}">
            <span class="init">${t.initiative}</span> ${t.name}${t.hidden ? ' (hidden)' : ''}</li>`,
        )}
      </ol>`);
  }

  /* What the creature whose turn it is has left, and the things anyone can do on their turn. */
  const SPEED_ZERO = ['Dead', 'Unconscious', 'Petrified', 'Paralyzed', 'Grappled', 'Restrained'];
  const turnOf = (t) => t?.turn || {};
  const speedOf = (t) => (t.conditions || []).some((c) => SPEED_ZERO.includes(c)) ? 0 : Number(t.stats?.speed ?? 30);
  const movementLeft = (t) => speedOf(t) * (1 + (turnOf(t).dash || 0)) - (turnOf(t).moved || 0);
  const actionsLeft = (t) => (turnOf(t).actions || 1) - (turnOf(t).actions_used || 0);

  function economyBar(current, mine) {
    const pill = (label, used, title = '') => html`<span class="econ ${used ? 'used' : ''}" title="${title}">${label}</span>`;
    const pills = (t) => {
      const tr = turnOf(t);
      const acts = actionsLeft(t);
      return html`
        ${pill(tr.actions > 1 ? `Actions: ${Math.max(0, acts)} left` : 'Action', acts <= 0)}
        ${tr.attacks_left > 0 ? pill(`${tr.attacks_left} more attack${tr.attacks_left > 1 ? 's' : ''}`, false, 'Extra Attack: more attacks from the same action') : ''}
        ${pill('Bonus action', !!tr.bonus)}
        ${pill('Reaction', !!tr.reaction, 'Comes back at the start of your turn')}
        ${pill(`Move: ${Math.max(0, movementLeft(t))} of ${speedOf(t) * (1 + (tr.dash || 0))} ft`, movementLeft(t) <= 0)}`;
    };
    if (!current) return mine ? html`<div class="turn-economy"><span class="muted">${mine.name}:</span>${pill('Reaction', !!turnOf(mine).reaction)}</div>` : '';
    const myTurn = !isDm && current.owner_id === me;
    if (isDm) {
      return html`<div class="turn-economy"><span class="muted">${current.name}:</span>${pills(current)}</div>`;
    }
    if (!myTurn) {
      return mine ? html`<div class="turn-economy"><span class="muted">${mine.name}:</span>${pill('Reaction', !!turnOf(mine).reaction, 'You can use it on anyone’s turn')}
        <span class="muted small">You can act and move on your turn.</span></div>` : '';
    }
    const ch = myCharacter();
    const extra = ch ? classBonusActions(ch.data, rules) : {};
    const tr = turnOf(current);
    const uses = ch?.data.featureUses || {};
    const left = (key) => Math.max(0, (current.stats?.[key] || 0) - (Number(uses[key]) || 0));
    const prone = (current.conditions || []).includes('Prone');
    const raging = (current.conditions || []).includes('Raging');
    const btn = (what, label, use = 'action', disabled = false, title = '') =>
      html`<button type="button" class="chip act" data-act="turn-action" data-what="${what}" data-use="${use}" ${disabled ? raw('disabled') : ''} title="${title}">${label}</button>`;
    const noAction = actionsLeft(current) <= 0;
    return html`<div class="turn-economy">${pills(current)}</div>
      <div class="turn-economy">
        ${btn('dash', 'Dash', 'action', noAction, 'Doubles your movement this turn')}
        ${btn('disengage', 'Disengage', 'action', noAction)}
        ${btn('dodge', 'Dodge', 'action', noAction)}
        ${btn('hide', 'Hide', 'action', noAction)}
        ${btn('help', 'Help', 'action', noAction)}
        ${prone ? btn('stand', `Stand up (${Math.floor(speedOf(current) / 2)} ft)`, 'free', movementLeft(current) < Math.floor(speedOf(current) / 2)) : ''}
        ${extra.cunning || extra.actionSurge || extra.secondWind || extra.rage ? html`<span class="sep"></span>` : ''}
        ${extra.cunning
          ? html`${btn('dash', 'Dash (bonus)', 'bonus', !!tr.bonus, 'Cunning Action')}${btn('disengage', 'Disengage (bonus)', 'bonus', !!tr.bonus, 'Cunning Action')}${btn('hide', 'Hide (bonus)', 'bonus', !!tr.bonus, 'Cunning Action')}`
          : ''}
        ${extra.actionSurge ? btn('action_surge', `Action Surge (${left('actionSurge')} left)`, 'free', !left('actionSurge') || !!tr.surged, 'One more action this turn') : ''}
        ${extra.secondWind ? btn('second_wind', `Second Wind (${left('secondWind')} left)`, 'bonus', !left('secondWind') || !!tr.bonus, 'Bonus action: heal 1d10 + your Fighter level') : ''}
        ${extra.rage
          ? raging
            ? btn('end_rage', 'End Rage', 'free')
            : btn('rage', `Rage (${left('rage')} left)`, 'bonus', !left('rage') || !!tr.bonus, 'Bonus action: resist Bludgeoning, Piercing and Slashing damage')
          : ''}
      </div>`;
  }

  /** How far a token may still move (null = no limit). Only players are limited, in combat. */
  function moveInfo(t) {
    const c = s.campaign;
    if (isDm || c.combat_round == null || t.map_id !== c.active_map_id) return null;
    if (c.combat_turn !== t.id) return { left: 0, reason: 'wait for your turn to move' };
    const held = (t.conditions || []).find((x) => SPEED_ZERO.includes(x));
    if (held) return { left: 0, reason: `you can't move while ${held.toLowerCase()}` };
    return { left: movementLeft(t), factor: (t.conditions || []).includes('Prone') ? 2 : 1 };
  }

  /* Area spells stay on the map for the rest of the turn (or 20 seconds outside combat). */
  const AREA_NAMES = { circle: 'radius circle', cone: 'cone', line: 'line', cube: 'cube' };
  function rememberArea(row) {
    const a = row?.result?.area;
    if (!a || typeof a !== 'object') return;
    ui.areas.push({ ...a, turn: s.campaign.combat_round != null ? s.campaign.combat_turn : null, at: Date.now() });
    ui.areas = ui.areas.slice(-6);
    drawBoard();
    setTimeout(() => drawBoard(), 20500);
  }
  function recentAreas() {
    const turn = s.campaign.combat_round != null ? s.campaign.combat_turn : null;
    return ui.areas.filter((a) => (turn && a.turn === turn) || Date.now() - a.at < 20000);
  }

  function checkTurn() {
    const turn = s.campaign.combat_round != null ? s.campaign.combat_turn : null;
    if (turn && turn !== ui.lastTurn) {
      const t = s.tokens.find((x) => x.id === turn);
      if (t && t.owner_id === me && !isDm) toast(`Your turn, ${t.name}!`, 'success');
    }
    ui.lastTurn = turn;
  }

  function initiativeBonus(t) {
    if (t.monster_id) {
      const mon = monsterById(t.monster_id);
      return mon?.initiative?.bonus ?? mon?.abilities?.dex?.mod ?? 0;
    }
    const ch = t.character_id && s.characters[t.character_id];
    if (ch) {
      const d = derive(ch.data, rules);
      return d.initiative - d.d20Penalty;
    }
    return 0;
  }

  /** Advantage/disadvantage from the dice box applies to the next attack, then resets. */
  function takeMode() {
    const m = ui.rollMode;
    if (m !== 'normal') {
      ui.rollMode = 'normal';
      drawMode();
    }
    return m;
  }

  /**
   * Choose targets on the map. opts: label, run(ids), and for more than one
   * target multi: true with max (how many) and repeat (the same creature can
   * be picked again: rays, darts, beams). targets: already chosen (an area).
   */
  function startTarget(opts) {
    ui.target = { max: Infinity, ...opts, targets: opts.targets || [] };
    ui.pending = null;
    ui.aim = null;
    drawToolbar();
    drawBoard();
    if (!opts.area) toast(opts.multi ? (opts.repeat ? `Click a creature for each of the ${opts.max} ${opts.shots || 'attacks'}.` : 'Click each creature to target.') : `Click who to target with ${opts.label}.`);
    root.querySelector('.board-host')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function targetPrompt(tg) {
    const name = (id) => s.tokens.find((t) => t.id === id)?.name || '?';
    const counts = new Map();
    for (const id of tg.targets) counts.set(id, (counts.get(id) || 0) + 1);
    const chosen = [...counts].map(([id, n]) => (n > 1 ? `${name(id)} ×${n}` : name(id))).join(', ');
    if (tg.area) return html`Everyone in the area is chosen (${tg.targets.length}). Click a creature to leave it out or add it, then`;
    if (tg.repeat) return html`Click a creature for each of the ${tg.max} ${tg.shots || 'attacks'} (${tg.targets.length} chosen${chosen ? `: ${chosen}` : ''}), then`;
    const most = Number.isFinite(tg.max) ? ` of up to ${tg.max}` : '';
    return html`Click each target (${tg.targets.length}${most} chosen${chosen ? `: ${chosen}` : ''}), then`;
  }

  /** Start aiming an area spell; when it's placed, everyone inside is chosen. */
  function startAim(opts) {
    ui.aim = opts;
    ui.target = null;
    ui.pending = null;
    drawToolbar();
    drawBoard();
    toast(`Move over the map to aim ${opts.label.replace(/^Cast /, '')}, then click.`);
    root.querySelector('.board-host')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function placeArea(geom) {
    const aim = ui.aim;
    if (!aim) return;
    const m = viewMap();
    const visible = s.tokens.filter((t) => t.map_id === m.id && !(t.conditions || []).includes('Dead'));
    const inside = tokensInArea(geom, visible, aim.casterId).map((t) => t.id);
    ui.aim = null;
    startTarget({ label: aim.label, multi: true, area: packArea(geom, m.id), targets: inside, run: (ids, tg) => aim.run(ids, tg.area) });
  }

  async function pickTarget(t) {
    const tg = ui.target;
    if (tg.multi) {
      if (tg.repeat) {
        if (tg.targets.length >= tg.max) return toast(`${tg.label.replace(/^Cast /, '')} has only ${tg.max} ${tg.shots || 'attacks'}. Press the button to cast it, or Undo last.`);
        tg.targets = [...tg.targets, t.id];
      } else if (tg.targets.includes(t.id)) {
        tg.targets = tg.targets.filter((x) => x !== t.id);
      } else {
        if (tg.targets.length >= tg.max) return toast(`${tg.label.replace(/^Cast /, '')} can only target ${tg.max} creature${tg.max === 1 ? '' : 's'}.`, 'error');
        tg.targets = [...tg.targets, t.id];
      }
      drawToolbar();
      drawBoard();
      return;
    }
    ui.target = null;
    drawToolbar();
    drawBoard();
    await resolveTarget(tg, [t.id]);
  }

  async function resolveTarget(tg, ids) {
    const res = await guard(() => tg.run(ids, tg));
    if (!res) return;
    report(res);
    if (res.area) rememberArea({ result: res });
    queueReload(['tokens', 'members', 'campaign']);
  }

  function report(x) {
    if (x.kind === 'attacks') {
      const hits = x.results.filter((r) => r.hit);
      const dmg = hits.reduce((n, r) => n + (r.damage || 0), 0);
      toast(`${hits.length} of ${x.results.length} hit${dmg ? ` for ${dmg} damage in all` : ''}.`, hits.length ? 'success' : '');
    } else if (x.kind === 'attack') {
      toast(x.hit ? `${x.crit ? 'Critical hit! ' : x.auto ? '' : 'Hit! '}${x.target} takes ${x.damage} damage${x.down ? ' and drops!' : '.'}` : `Miss! ${x.attacker} misses ${x.target}.`, x.hit ? 'success' : '');
    } else if (x.kind === 'save') {
      const failed = x.targets.filter((t) => !t.saved).length;
      toast(`${x.targets.length - failed} saved, ${failed} failed.`, 'success');
    } else if (x.kind === 'heal') {
      toast(`${x.target} regains ${x.amount} hit points.`, 'success');
    }
  }

  /** The DM's browser keeps the party's AC, max HP and saves up to date in the database. */
  async function syncParty() {
    if (!isDm) return;
    for (const t of s.tokens) {
      // What each creature can do in a turn (speed, Extra Attack, class features, spell slots).
      let stats = null;
      if (t.kind === 'pc' && t.character_id && s.characters[t.character_id]) stats = combatStats(s.characters[t.character_id].data, rules);
      else if (t.monster_id && monsterById(t.monster_id)) stats = { speed: walkSpeed(monsterById(t.monster_id).speed) };
      if (stats && stableJson(stats) !== stableJson(t.stats || {})) {
        t.stats = stats;
        await store.updateToken(t.id, { stats }).catch((err) => console.error(err));
      }
      if (t.kind !== 'pc' || !t.character_id || !s.characters[t.character_id]) continue;
      const want = characterSecrets(s.characters[t.character_id].data, rules);
      const have = s.secrets[t.id] || {};
      const same = have.ac === want.ac && have.hp_max === want.hp_max && Object.keys(want.saves).every((k) => Number(have.saves?.[k]) === want.saves[k]);
      if (same) continue;
      s.secrets[t.id] = { ...have, ...want, token_id: t.id };
      await store.saveSecret(t.id, s.id, want).catch((err) => console.error(err));
    }
  }

  function drawMode() {
    for (const b of els.diceForm.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === ui.rollMode));
  }

  const TABS = isDm
    ? [
        ['enemies', 'Enemies'],
        ['party', 'Party'],
        ['maps', 'Maps'],
        ['images', 'Images'],
        ['token', 'Selected'],
      ]
    : [
        ['character', 'My character'],
        ['party', 'Party'],
        ['images', 'Images'],
      ];

  function drawSide({ force = false } = {}) {
    els.tabs.innerHTML = String(
      html`${TABS.map(([id, label]) => html`<button type="button" role="tab" data-tab="${id}" aria-selected="${ui.tab === id}">${label}</button>`)}`,
    );
    // Don't wipe out what someone is typing when the table updates.
    const focused = document.activeElement;
    if (!force && focused && els.body.contains(focused) && focused.matches('input, textarea, select')) {
      ui.sideDirty = true;
      return;
    }
    ui.sideDirty = false;
    const scrollTop = els.body.scrollTop;
    const view = {
      enemies: enemiesTab,
      party: partyTab,
      maps: mapsTab,
      images: imagesTab,
      token: tokenTab,
      character: characterTab,
    }[ui.tab];
    els.body.innerHTML = String(view());
    // Keep the scroll position on a refresh, but start a newly opened tab at the top.
    els.body.scrollTop = ui.drawnTab === ui.tab ? scrollTop : 0;
    ui.drawnTab = ui.tab;
  }

  /* ---------------------------------------------------------- DM: enemies */
  function enemiesTab() {
    const q = ui.search.trim().toLowerCase();
    const found = (q ? monsters.filter((m) => m.name.toLowerCase().includes(q) || (m.group || '').toLowerCase().includes(q)) : monsters).slice(0, 60);
    return html`
      <div class="panel">
        <p class="muted small">Drag an enemy onto the map, or press <strong>Place</strong> and click a square.</p>
        <label class="sr-only" for="monster-search">Search enemies</label>
        <input id="monster-search" type="search" placeholder="Search 330 creatures, e.g. goblin, dragon" value="${ui.search}" data-input="search">
        <label class="check"><input type="checkbox" data-input="spawn-hidden" ${ui.spawnHidden ? raw('checked') : ''}> Hidden from players until I reveal it</label>
        <label class="check"><input type="checkbox" data-input="roll-hp" ${ui.rollHp ? raw('checked') : ''}> Roll hit points instead of using the average</label>
        <ul class="spawn-list">
          ${found.map(
            (m) => html`<li class="spawn" draggable="true" data-drag="${JSON.stringify({ type: 'monster', id: m.id })}">
              <span class="spawn-name"><strong>${m.name}</strong><span class="muted small">CR ${m.cr?.rating ?? '—'} · ${m.size?.join('/')} · HP ${m.hp?.average ?? '—'} · AC ${m.acValue ?? m.ac}</span></span>
              <button type="button" class="button small secondary" data-act="place" data-type="monster" data-id="${m.id}">Place</button>
            </li>`,
          )}
        </ul>
        ${found.length === 0 ? html`<p class="muted">No creatures match “${ui.search}”.</p>` : ''}
        <details class="custom-token">
          <summary>Make your own token</summary>
          <form data-form="custom-token" class="stack">
            <label>Name <input name="name" required maxlength="80" placeholder="Captain Vex"></label>
            <div class="row">
              <label>Type <select name="kind"><option value="monster">Enemy</option><option value="npc">Friendly NPC</option></select></label>
              <label>Size <select name="size"><option value="1">1 square</option><option value="2">2×2</option><option value="3">3×3</option><option value="4">4×4</option></select></label>
            </div>
            <div class="row">
              <label>HP <input name="hp" type="number" min="0" max="9999" inputmode="numeric"></label>
              <label>AC <input name="ac" type="number" min="0" max="50" inputmode="numeric"></label>
              <label>Colour <input name="color" type="color" value="#6b3f8b"></label>
            </div>
            <button class="button small">Place on map</button>
          </form>
        </details>
      </div>`;
  }

  /* ------------------------------------------------------------ party */
  function partyTab() {
    const m = viewMap();
    const code = s.campaign.join_code;
    return html`
      <div class="panel">
        ${isDm
          ? html`<div class="invite-box">
              <p class="muted small">Players join with this code on their home screen, or with the link.</p>
              <p class="join-code" aria-label="Join code">${code}</p>
              <div class="row">
                <button type="button" class="button small" data-act="copy-link">Copy invite link</button>
                <button type="button" class="button small secondary" data-act="copy-code">Copy code</button>
                <button type="button" class="link-button small" data-act="new-code">Make a new code</button>
              </div>
            </div>`
          : ''}
        <h2 class="panel-title">Party</h2>
        <ul class="party-list">
          ${s.members.map((p) => {
            const ch = s.characters[p.character_id];
            const d = ch ? derive(ch.data, rules) : null;
            const onMap = m && s.tokens.some((t) => t.map_id === m.id && t.owner_id === p.user_id);
            const drag = isDm && p.role === 'player' && ch ? JSON.stringify({ type: 'pc', userId: p.user_id }) : null;
            return html`<li class="party-member" ${drag ? raw(`draggable="true" data-drag="${escAttr(drag)}"`) : ''}>
              <div>
                <strong>${p.name}</strong>${p.user_id === me ? ' (you)' : ''}
                <span class="badge ${p.role}">${p.role === 'dm' ? 'DM' : 'Player'}</span>
                <div class="muted small">${p.role === 'dm'
                  ? 'Runs the game'
                  : ch
                    ? `${ch.name}${d?.cls ? ` · ${d.cls.name} ${d.level}` : ''}${isDm && d ? ` · AC ${d.ac} · HP ${ch.data.hp?.current ?? d.hpMax}/${d.hpMax} · Passive Perception ${d.passivePerception}` : ''}`
                    : p.character_id ? 'Character chosen' : 'No character chosen yet'}</div>
              </div>
              ${isDm && p.role === 'player'
                ? html`<div class="row">
                    ${ch && m ? html`<button type="button" class="button small ${onMap ? 'secondary' : ''}" data-act="place" data-type="pc" data-user="${p.user_id}">${onMap ? 'Add another token' : 'Place on map'}</button>` : ''}
                    <button type="button" class="link-button small danger" data-act="remove-player" data-user="${p.user_id}" data-name="${p.name}">Remove</button>
                  </div>`
                : ''}
            </li>`;
          })}
        </ul>
        ${isDm && s.members.length < 2 ? html`<p class="muted">Nobody has joined yet. Send your players the invite link.</p>` : ''}
        ${isDm ? restAndXp() : ''}
        ${isDm
          ? html`<hr><button type="button" class="button small danger" data-act="delete-campaign">Delete campaign</button>`
          : html`<hr><button type="button" class="button small secondary" data-act="leave">Leave campaign</button>`}
      </div>`;
  }

  function restAndXp() {
    const m = activeMap();
    const defeatedXp = s.tokens
      .filter((t) => m && t.map_id === m.id && t.kind === 'monster' && (t.conditions || []).includes('Dead'))
      .reduce((sum, t) => sum + (Number(s.secrets[t.id]?.xp) || 0), 0);
    return html`
      <h2 class="panel-title">Rests and XP</h2>
      <div class="row">
        <button type="button" class="button small secondary" data-act="rest" data-kind="short">Short rest</button>
        <button type="button" class="button small secondary" data-act="rest" data-kind="long">Long rest</button>
      </div>
      <p class="muted small">Long rest: full HP, spell slots and Hit Dice back, one less Exhaustion. Short rest: Warlocks get their slots back; players spend Hit Dice on their own tab.</p>
      <form data-form="xp" class="row">
        <label>XP to share <input name="amount" type="number" min="1" max="1000000" inputmode="numeric" value="${defeatedXp || ''}" required></label>
        <button class="button small">Give to the party</button>
      </form>
      ${defeatedXp ? html`<p class="muted small">Defeated enemies on this map are worth ${defeatedXp} XP in total.</p>` : ''}`;
  }

  /* ------------------------------------------------------------- maps */
  function mapsTab() {
    const m = viewMap();
    const active = activeMap();
    return html`
      <div class="panel">
        <h2 class="panel-title">Maps</h2>
        <ul class="map-list">
          ${s.maps.map(
            (x) => html`<li class="${x.id === m?.id ? 'current' : ''}">
              <button type="button" class="link-button" data-act="view-map" data-id="${x.id}">${x.name}</button>
              ${x.id === active?.id
                ? html`<span class="badge player">Players see this</span>`
                : html`<button type="button" class="button small secondary" data-act="activate-map" data-id="${x.id}">Open for players</button>`}
            </li>`,
          )}
        </ul>
        <button type="button" class="button small" data-act="new-map">New map</button>
        ${m
          ? html`<hr>
            <form data-form="map" class="stack">
              <h3>${m.name}</h3>
              <label>Name <input name="name" value="${m.name}" maxlength="80" required></label>
              <div class="row">
                <label>Columns <input name="cols" type="number" min="5" max="100" value="${m.cols}" required></label>
                <label>Rows <input name="rows" type="number" min="5" max="100" value="${m.rows}" required></label>
                <label title="How many squares a player's token lights up around it">Sight <input name="vision" type="number" min="0" max="30" value="${m.vision}" required></label>
              </div>
              <button class="button small">Save map</button>
            </form>
            <div class="stack">
              <label class="file-button button small secondary">${m.background_path ? 'Change background image' : 'Add background image'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-input="map-bg" hidden></label>
              ${m.background_path ? html`<button type="button" class="link-button small" data-act="remove-bg">Remove background</button>` : ''}
              <p class="muted small">Tip: set the columns and rows to match the squares drawn on your image.</p>
            </div>
            <hr>
            <h3>Fog of war</h3>
            <p class="muted small">${countRevealed(fitFog(m.revealed, m.cols, m.rows))} of ${m.cols * m.rows} squares revealed. Players reveal fog as they move. Use “Reveal fog” above the map to paint it away.</p>
            <div class="row">
              <button type="button" class="button small secondary" data-act="fog-all" data-value="1">Reveal whole map</button>
              <button type="button" class="button small secondary" data-act="fog-all" data-value="0">Cover whole map</button>
            </div>
            <hr>
            <button type="button" class="button small danger" data-act="delete-map" data-id="${m.id}">Delete this map</button>`
          : ''}
      </div>`;
  }

  /* ----------------------------------------------------------- images */
  function imagesTab() {
    const list = isDm ? s.handouts : s.handouts.filter((h) => h.shown);
    return html`
      <div class="panel">
        ${isDm
          ? html`<form data-form="handout" class="stack">
              <p class="muted small">Upload pictures to show your players at the right moment: a boss, a letter, a place.</p>
              <label>Title <input name="title" maxlength="120" placeholder="The Dragon awakens"></label>
              <label class="file-button button small">Choose image <input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif" required hidden></label>
              <span class="muted small file-name"></span>
              <button class="button small">Upload</button>
            </form><hr>`
          : ''}
        <ul class="handout-list">
          ${list.map(
            (h) => html`<li class="handout ${h.shown ? 'shown' : ''}">
              <button type="button" class="handout-thumb" data-act="open-handout" data-id="${h.id}"><img alt="" data-img="${h.image_path}"></button>
              <div>
                <strong>${h.title || 'Untitled image'}</strong>
                ${isDm
                  ? html`<div class="row">
                      <button type="button" class="button small ${h.shown ? 'secondary' : ''}" data-act="show-handout" data-id="${h.id}" data-shown="${h.shown ? '0' : '1'}">${h.shown ? 'Hide from players' : 'Show to players'}</button>
                      <button type="button" class="link-button small danger" data-act="delete-handout" data-id="${h.id}">Delete</button>
                    </div>`
                  : ''}
              </div>
            </li>`,
          )}
        </ul>
        ${list.length === 0 ? html`<p class="muted">${isDm ? 'No images yet.' : 'The DM hasn’t shown any images yet.'}</p>` : ''}
      </div>`;
  }

  /* ---------------------------------------------------- DM: selected token */
  function tokenTab() {
    const t = selected();
    if (!t) return html`<div class="panel"><p class="muted">Click a token on the map to see and change it here.</p></div>`;
    const sec = s.secrets[t.id] || {};
    const mon = t.monster_id ? monsterById(t.monster_id) : null;
    const ch = t.character_id ? s.characters[t.character_id] : null;
    const d = ch ? derive(ch.data, rules) : null;
    return html`
      <div class="panel">
        <form data-form="token" class="stack">
          <div class="row">
            <label class="grow">Name <input name="name" value="${t.name}" maxlength="80" required></label>
            <label>Colour <input name="color" type="color" value="${t.color}"></label>
          </div>
          <div class="row">
            <label>Size <select name="size">${[1, 2, 3, 4].map((n) => html`<option value="${n}" ${t.size === n ? raw('selected') : ''}>${n === 1 ? '1 square' : `${n}×${n}`}</option>`)}</select></label>
            ${t.kind !== 'pc' ? html`<label>AC <input name="ac" type="number" min="0" max="50" value="${sec.ac ?? ''}"></label>` : ''}
          </div>
          ${t.kind !== 'pc'
            ? html`<div class="row">
                <label>HP <input name="hp_current" type="number" min="-999" max="9999" value="${sec.hp_current ?? ''}"></label>
                <label>Max HP <input name="hp_max" type="number" min="0" max="9999" value="${sec.hp_max ?? ''}"></label>
              </div>
              <label>DM notes (players never see these) <textarea name="notes" rows="2" maxlength="5000">${sec.notes ?? ''}</textarea></label>`
            : ''}
          <button class="button small">Save</button>
        </form>
        ${t.kind === 'pc' ? html`<p class="muted small">${ch ? `${ch.name}: AC ${d.ac}, HP ${ch.data.hp?.current ?? d.hpMax}/${d.hpMax}, Speed ${d.speed} ft.` : 'Player token'}</p>` : ''}
        ${t.kind !== 'pc' || ch
          ? html`<form data-form="hp-change" class="row hp-change">
              <label class="sr-only" for="hp-amount">Amount</label>
              <input id="hp-amount" name="amount" type="number" min="1" max="9999" placeholder="Amount" inputmode="numeric" required>
              <button class="button small danger" name="kind" value="damage">Damage</button>
              <button class="button small secondary" name="kind" value="heal">Heal</button>
            </form>`
          : ''}
        ${conditionChips(t, 'toggle-condition')}
        ${s.campaign.combat_round != null ? html`<p><button type="button" class="button small secondary" data-act="token-initiative">${t.initiative == null ? 'Roll initiative' : `Initiative ${t.initiative} (reroll)`}</button></p>` : ''}
        <div class="row">
          <button type="button" class="button small ${t.hidden ? '' : 'secondary'}" data-act="toggle-hidden">${t.hidden ? 'Reveal to players' : 'Hide from players'}</button>
          <button type="button" class="button small secondary" data-act="duplicate-token">Duplicate</button>
          <button type="button" class="link-button small danger" data-act="delete-token">Remove from map</button>
        </div>
        ${t.hidden ? html`<p class="muted small">Players can't see this token.</p>` : ''}
        ${mon ? monsterPanel(mon) : ''}
      </div>`;
  }

  function monsterPanel(mon) {
    const attacks = (mon.actions || []).filter((a) => a.attack);
    const saves = Object.entries(mon.abilities || {});
    const auto = monsterActions(mon);
    return html`
      <hr>
      ${auto.length
        ? html`<h3>Actions</h3>
          <p class="muted small">Pick an action, then click the target on the map. The site rolls and applies the damage.</p>
          <div class="roll-buttons">
            ${auto.map(
              (a, i) => html`<button type="button" class="chip act" data-act="monster-action" data-index="${i}">
                ${a.kind === 'attack' ? '⚔' : '✸'} ${a.name}${a.kind === 'attack' ? ` ${formatMod(a.bonus)}` : ` (DC ${a.dc} ${a.save.toUpperCase()})`}${a.damage ? ` · ${a.damage} ${a.damageType}` : ''}${a.extra?.length ? ` + ${a.extra.map((x) => `${x.dice} ${x.type}`).join(' + ')}` : ''}</button>`,
            )}
          </div>
          ${auto.some((a) => a.rider) ? html`<p class="muted small">Some hits also force a saving throw; use Saving throws below for those.</p>` : ''}`
        : ''}
      <h3>Roll for ${mon.name}</h3>
      <div class="roll-buttons">
        ${mon.initiative ? html`<button type="button" class="chip" data-act="roll" data-label="${mon.name}: Initiative" data-expr="${withMod('1d20', mon.initiative.bonus)}" data-d20="1">Initiative ${formatMod(mon.initiative.bonus)}</button>` : ''}
        ${attacks.map(
          (a) => html`<button type="button" class="chip" data-act="roll" data-label="${mon.name}: ${a.name}" data-expr="${withMod('1d20', a.attack.bonus)}" data-d20="1">${a.name} ${formatMod(a.attack.bonus)}</button>
            ${a.attack.damage.map((dmg) => html`<button type="button" class="chip dmg" data-act="roll" data-label="${mon.name}: ${a.name} damage (${dmg.type})" data-expr="${cleanDice(dmg.dice)}">${dmg.dice} ${dmg.type}</button>`)}`,
        )}
      </div>
      <details><summary>Saving throws</summary><div class="roll-buttons">
        ${saves.map(([k, v]) => html`<button type="button" class="chip" data-act="roll" data-label="${mon.name}: ${ABILITY_NAMES[k]} save" data-expr="${withMod('1d20', v.save)}" data-d20="1">${k.toUpperCase()} ${formatMod(v.save)}</button>`)}
      </div></details>
      <p class="muted small">The DM's rolls for enemies are secret unless you untick “Secret”.</p>
      <details class="statblock-wrap"><summary>Stat block</summary>${statBlock(mon)}</details>`;
  }

  function conditionChips(t, act) {
    const on = new Set(t.conditions || []);
    return html`<details class="conditions-box" ${on.size ? raw('open') : ''}><summary>Conditions${on.size ? `: ${[...on].join(', ')}` : ''}</summary>
      <div class="roll-buttons">${[...CONDITIONS, 'Dead'].map(
        (n) => html`<button type="button" class="chip ${on.has(n) ? 'on' : ''}" data-act="${act}" data-name="${n}" aria-pressed="${on.has(n)}">${n}</button>`,
      )}</div></details>`;
  }

  /* ------------------------------------------------- player: character */
  function characterTab() {
    const mine = myMember();
    const ch = myCharacter();
    if (!ch || ui.changingCharacter) {
      if (!ui.myCharacters) {
        listCharacters()
          .then((list) => {
            ui.myCharacters = list;
            drawSide({ force: true });
          })
          .catch((err) => toast(err.message, 'error'));
        return html`<div class="panel"><p class="loading">Loading your characters…</p></div>`;
      }
      return html`
        <div class="panel">
          <h2 class="panel-title">Choose your character</h2>
          ${ui.myCharacters.length
            ? html`<ul class="pick-list">
                ${ui.myCharacters.map(
                  (c) => html`<li><button type="button" class="pick ${c.id === mine?.character_id ? 'current' : ''}" data-act="choose-character" data-id="${c.id}">
                    <strong>${c.name}</strong><span class="muted small">${summary(c.data)}</span></button></li>`,
                )}
              </ul>`
            : html`<p>You don't have any characters yet.</p>`}
          <p><a class="button small secondary" href="#/characters/new">Create a character</a> <a class="link-button small" href="#/characters">Import one from a file</a></p>
          ${ui.changingCharacter ? html`<button type="button" class="link-button small" data-act="cancel-change">Keep my current character</button>` : ''}
        </div>`;
    }
    const d = derive(ch.data, rules);
    const pen = d.d20Penalty;
    const r = (label, mod) => html`<button type="button" class="chip" data-act="roll" data-label="${ch.name}: ${label}" data-expr="${withMod('1d20', mod - pen)}" data-d20="1">${label} ${formatMod(mod - pen)}</button>`;
    const hasToken = s.tokens.some((t) => t.owner_id === me);
    const tok = myToken();
    return html`
      <div class="panel">
        <div class="char-head">
          <div>
            <h2 class="panel-title">${ch.name}</h2>
            <p class="muted small">${summary(ch.data)}</p>
          </div>
          <a class="button small secondary" href="#/characters/${ch.id}" target="_blank" rel="noopener">Open sheet</a>
        </div>
        <div class="char-stats">
          <span><strong>${ch.data.hp?.current ?? d.hpMax}</strong>/${d.hpMax} HP</span>
          <span><strong>${d.ac}</strong> AC</span>
          <span><strong>${d.speed}</strong> ft.</span>
          <span><strong>${d.passivePerception}</strong> Passive Perception</span>
        </div>
        ${!hasToken ? html`<p class="muted small">Your DM will place your token on the map.</p>` : html`<p class="muted small">Drag your token to move. Fog clears around you as you go.</p>`}
        ${vitalsPanel(ch, d, tok)}
        ${s.campaign.combat_round != null && tok
          ? html`<div class="roll-buttons">${tok.initiative == null ? html`<button type="button" class="chip act" data-act="my-initiative">Roll initiative ${formatMod(d.initiative - pen)}</button>` : html`<span class="muted small">Initiative ${tok.initiative}</span>`}</div>`
          : html`<div class="roll-buttons">${r('Initiative', d.initiative)}</div>`}
        <h3>Attacks</h3>
        ${tok ? html`<p class="muted small">Pick an attack, then click your target on the map. Hit or miss, and the damage, are worked out for you.${s.campaign.combat_round != null ? ' In combat, attacking uses your action (Extra Attack gives you more than one).' : ''}</p>` : ''}
        <div class="roll-buttons">
          ${d.attacks.map((a) =>
            tok
              ? html`<button type="button" class="chip act" data-act="attack-weapon" data-uid="${a.uid}">⚔ ${a.name} ${formatMod(a.toHit - pen)} · ${a.damage} ${a.damageType}</button>`
              : html`<button type="button" class="chip" data-act="roll" data-label="${ch.name}: ${a.name}" data-expr="${withMod('1d20', a.toHit - pen)}" data-d20="1">${a.name} ${formatMod(a.toHit - pen)}</button>
                  <button type="button" class="chip dmg" data-act="roll" data-label="${ch.name}: ${a.name} damage" data-expr="${a.damage}">${a.damage} ${a.damageType}</button>`,
          )}
        </div>
        ${tok ? bonusAttacks(ch, d) : ''}
        ${d.spell ? spellsPanel(ch, d, tok) : ''}
        <h4>Ability checks</h4>
        <div class="roll-buttons">${Object.keys(ABILITY_NAMES).map((k) => r(ABILITY_NAMES[k], d.mods[k]))}</div>
        <h4>Saving throws</h4>
        <div class="roll-buttons">${Object.keys(ABILITY_NAMES).map((k) => r(`${ABILITY_NAMES[k]} save`, d.saves[k].bonus))}</div>
        <details><summary>Skills</summary><div class="roll-buttons">${Object.keys(SKILLS).map((k) => r(k, d.skills[k].bonus))}</div></details>
        <hr>
        <button type="button" class="link-button small" data-act="change-character">Bring a different character</button>
      </div>`;
  }

  /** Bonus action attacks: Martial Arts, or a second Light weapon. */
  function bonusAttacks(ch, d) {
    const extra = classBonusActions(ch.data, rules);
    const unarmed = d.attacks.find((a) => a.uid === 'unarmed');
    if (!extra.martialArts && !extra.offHand.length) return '';
    const pen = d.d20Penalty;
    return html`<h4>Bonus action attacks</h4>
      <div class="roll-buttons">
        ${extra.martialArts && unarmed ? html`<button type="button" class="chip act" data-act="attack-weapon" data-uid="unarmed" data-bonus="1" title="Martial Arts">⚔ Unarmed Strike (bonus) ${formatMod(unarmed.toHit - pen)}</button>` : ''}
        ${extra.offHand.map((a) => html`<button type="button" class="chip act" data-act="attack-weapon" data-uid="${a.uid}" data-bonus="1" title="Light weapon: no ability modifier to the damage">⚔ ${a.name} (off-hand, bonus) · ${offHandDamage(a.damage)}</button>`)}
      </div>`;
  }

  function vitalsPanel(ch, d, tok) {
    const hp = ch.data.hp?.current ?? d.hpMax;
    const ds = ch.data.deathSaves || { successes: 0, failures: 0 };
    const dead = (ch.data.conditions || []).includes('Dead');
    const diceLeft = d.level - (Number(ch.data.hitDiceSpent) || 0);
    return html`
      ${dead ? html`<p class="callout error">${ch.name} has died.</p>` : ''}
      ${hp === 0 && !dead
        ? html`<div class="callout death-box">
            <strong>You're down!</strong> Death saves: ${ds.successes} ✓ · ${ds.failures} ✗
            ${tok ? html`<button type="button" class="button small" data-act="death-save">Roll death saving throw</button>` : ''}
          </div>`
        : ''}
      ${tok
        ? html`<form data-form="my-hp" class="row hp-change">
            <label class="sr-only" for="my-hp-amount">Amount</label>
            <input id="my-hp-amount" name="amount" type="number" min="1" max="9999" placeholder="HP" inputmode="numeric" required>
            <button class="button small danger" name="kind" value="damage">Damage</button>
            <button class="button small secondary" name="kind" value="heal">Heal</button>
            <button class="button small secondary" name="kind" value="temp">Temp HP</button>
          </form>
          <div class="row">
            <button type="button" class="button small secondary" data-act="hit-die" ${diceLeft <= 0 || hp >= d.hpMax ? raw('disabled') : ''}>Spend a Hit Die (d${d.hitDie}, ${diceLeft} left)</button>
          </div>
          ${conditionChips({ conditions: ch.data.conditions || [] }, 'my-condition')}`
        : ''}`;
  }

  function spellsPanel(ch, d, tok) {
    const list = castableSpells(ch.data, rules);
    const slots = d.spell.slots || {};
    const used = ch.data.slotsUsed || {};
    return html`
      <h3>Spells</h3>
      <p class="muted small">Spell attack ${formatMod(d.spell.attack - d.d20Penalty)} · Save DC ${d.spell.saveDc}${tok ? ' · Casting spends the slot and works out the result.' : ''}</p>
      ${Object.keys(slots).length
        ? html`<div class="slot-line">${Object.entries(slots).map(([lvl, n]) => html`<span class="slot-pill">Level ${lvl}: <strong>${n - (Number(used[lvl]) || 0)}</strong>/${n}</span>`)}</div>`
        : ''}
      <ul class="spell-cast-list">
        ${list.map(({ spell, open }) => {
          const mech = spellMechanics(spell, { slotLevel: open[0] ?? spell.level, casterLevel: d.level, castingMod: d.mods[d.spell.ability] });
          const what = [
            mech.use === 'bonus' ? 'bonus action' : mech.use === 'reaction' ? 'reaction' : '',
            mech.kind === 'attack' ? `${mech.attackType} spell attack` : mech.kind === 'save' ? `${mech.save.toUpperCase()} save${mech.half ? ', half on success' : ''}` : mech.kind === 'heal' ? `heals ${mech.heal}` : mech.kind === 'auto' ? 'always hits' : '',
            mech.area ? `${mech.area.size}-ft ${AREA_NAMES[mech.area.shape]}` : mech.repeat ? `${mech.targets} ${mech.shots}` : mech.targets > 1 && mech.kind !== 'other' ? `up to ${mech.targets} targets` : '',
          ].filter(Boolean).join(', ');
          return html`<li>
            <div><strong>${spell.name}</strong> <span class="muted small">${spellLevelLabel(spell.level)}${what ? ` · ${what}` : ''}${mech.damage ? ` · ${mech.damage} ${mech.damageType}` : ''}${mech.condition ? ` · ${mech.condition}` : ''}</span></div>
            ${open.length
              ? html`<div class="row">
                  ${spell.level > 0 && open.length > 1
                    ? html`<label class="sr-only" for="slot-${spell.id}">Slot level</label>
                      <select id="slot-${spell.id}" class="slot-select">${open.map((l) => html`<option value="${l}">Level ${l} slot</option>`)}</select>`
                    : ''}
                  <button type="button" class="button small" data-act="cast" data-spell="${spell.id}" data-slot="${open[0]}">Cast</button>
                </div>`
              : html`<span class="muted small">No slots left</span>`}
          </li>`;
        })}
      </ul>
      ${list.length === 0 ? html`<p class="muted small">No spells prepared. Choose them on your sheet.</p>` : ''}`;
  }

  async function cast(spellId, slotLevel) {
    const ch = myCharacter();
    const d = derive(ch.data, rules);
    const spell = rules.spells.find((x) => x.id === spellId);
    const tok = myToken();
    const entry = castableSpells(ch.data, rules).find((x) => x.spell.id === spellId);
    if (slotLevel > 0 && !entry?.open.includes(slotLevel)) {
      return toast(`You have no level ${slotLevel} spell slots left. They come back when you rest.`, 'error');
    }
    const mech = spellMechanics(spell, { slotLevel, casterLevel: d.level, castingMod: d.mods[d.spell.ability] });
    const label = `${spell.name}${slotLevel > spell.level ? ` at level ${slotLevel}` : ''}`;
    // The database spends the slot and the action (or bonus action, or reaction) with the roll.
    const how = { use: mech.use, slot: slotLevel, spell: true };
    if (!tok) {
      // Not on the map: just mark the slot used and roll any damage.
      await guard(async () => {
        if (slotLevel > 0) await store.combat.useSlot(ch.id, slotLevel, (Number(ch.data.slotsUsed?.[slotLevel]) || 0) + 1);
        if (mech.damage) await store.rollDice(s.id, mech.damage, { label: `${ch.name} casts ${label} (${mech.damageType})` });
      }, `${ch.name} casts ${label}.`);
      return queueReload(['members']);
    }
    if (mech.kind === 'other') {
      await guard(async () => {
        await store.combat.action(tok.id, 'spell', { use: mech.use, slot: slotLevel, label });
        if (mech.damage) await store.rollDice(s.id, mech.damage, { label: `${ch.name}: ${label} (${mech.damageType})` });
      }, `${ch.name} casts ${label}.`);
      return queueReload(['members', 'tokens']);
    }
    const pen = d.d20Penalty;
    const many = mech.repeat || mech.targets > 1;
    const pick = (run) => startTarget({ label: many ? `Cast ${label}` : label, multi: many, max: mech.targets, repeat: mech.repeat, shots: mech.shots, run });
    if (mech.kind === 'attack' || mech.kind === 'auto') {
      pick((targets) =>
        store.combat.attack({
          attacker: tok.id, targets, bonus: d.spell.attack - pen, damage: mech.damage, damageType: mech.damageType,
          mode: mech.kind === 'auto' ? 'normal' : takeMode(), label: spell.name, auto: mech.kind === 'auto', ...how,
        }));
    } else if (mech.kind === 'save') {
      const run = (targets, area) =>
        store.combat.save({
          source: tok.id, targets, ability: mech.save, dc: d.spell.saveDc, damage: mech.damage, damageType: mech.damageType,
          half: mech.half, condition: mech.condition, label: spell.name, area, ...how,
        });
      if (mech.area) startAim({ label: `Cast ${label}`, area: mech.area, caster: mech.area.self ? tok : null, casterId: tok.id, run });
      else pick((targets) => run(targets, null));
    } else if (mech.kind === 'heal') {
      pick((targets) => store.combat.heal({ healer: tok.id, targets, amount: mech.heal, label: spell.name, ...how }));
    }
  }

  function summary(c) {
    const d = derive(c, rules);
    return [d.species?.name, d.cls ? `${d.cls.name} ${d.level}` : null].filter(Boolean).join(' · ') || 'Unfinished character';
  }

  /* ------------------------------------------------------------- dice log */
  function drawLog() {
    els.log.innerHTML = String(
      html`${s.rolls.slice(0, 50).map((r) => {
        const nat = r.mode !== 'normal' || /^1?d20/.test(r.expr) ? r.nat_roll : null;
        return html`<li class="roll ${r.private ? 'private' : ''} ${nat === 20 ? 'crit' : nat === 1 ? 'fumble' : ''}">
          <div class="roll-top">
            <span class="roll-who">${r.roller_name}${r.user_id === s.campaign.dm_id ? ' (DM)' : ''}</span>
            ${['rest', 'xp', 'save', 'action'].includes(r.result?.kind) ? '' : html`<span class="roll-total">${r.total}</span>`}
          </div>
          <div class="roll-what">${r.label || r.expr}${r.mode !== 'normal' ? html` <em>with ${r.mode}</em>` : ''}${r.private ? html` <span class="badge">${r.user_id === me ? 'secret' : 'private'}</span>` : ''}</div>
          ${outcome(r) ? html`<div class="roll-outcome ${r.result?.hit === false ? 'miss' : ''} ${r.result?.kind === 'damage' ? 'damage' : ''}">${outcome(r)}</div>` : ''}
          ${['rest', 'xp', 'action'].includes(r.result?.kind) ? '' : html`<div class="roll-detail muted small">${raw(strike(describeRoll(r)))}${nat === 20 ? ' · Natural 20!' : nat === 1 ? ' · Natural 1' : ''}</div>`}
        </li>`;
      })}`,
    );
    if (!s.rolls.length) els.log.innerHTML = '<li class="muted small">No rolls yet.</li>';
  }

  function outcome(r) {
    const x = r.result;
    if (!x) return '';
    if (x.kind === 'attack') {
      if (!x.hit) return x.attacker ? `Miss: ${x.attacker} misses ${x.target}` : 'Miss';
      // Older rows had the damage on the attack line; newer ones put it on its own line.
      if ('damage' in x) return `${x.crit ? 'Critical hit!' : 'Hit'}${x.damage ? ` · ${x.damage} damage` : ''}${x.dead ? ` · ${x.target} is dead` : x.down ? ` · ${x.target} drops` : ''}`;
      return `${x.crit ? 'Critical hit!' : 'Hit!'} ${x.attacker} hits ${x.target}`;
    }
    if (x.kind === 'damage') {
      const types = [x.damageType, ...(x.extra || [])].filter(Boolean).join(' and ');
      const changed = x.rolled != null && x.rolled !== x.damage ? ` (rolled ${x.rolled}; ${x.damage < x.rolled ? 'resisted' : 'vulnerable'})` : '';
      return `${x.target} takes ${x.damage}${types ? ` ${types}` : ''} damage${x.crit ? ' (critical)' : ''}${changed}${x.dead ? ` · ${x.target} is dead` : x.down ? ` · ${x.target} drops` : ''}`;
    }
    if (x.kind === 'save') {
      return x.targets
        .map((t) => `${t.name}: ${t.total} ${t.saved ? 'saved' : 'failed'}${t.damage ? `, ${t.damage} damage` : ''}${t.down ? ', drops' : ''}`)
        .join(' · ') + (x.condition ? ` (failed: ${x.condition})` : '');
    }
    if (x.kind === 'heal') return `${x.target} regains ${x.amount} HP`;
    if (x.kind === 'death') return x.outcome;
    return '';
  }

  function strike(text) {
    return String(html`${text}`).replace(/~~(\d+)~~/g, '<s>$1</s>');
  }

  function addRoll(row) {
    if (!row || s.rolls.some((r) => r.id === row.id)) return;
    s.rolls.unshift(row);
    s.rolls.length = Math.min(s.rolls.length, 50);
    drawLog();
  }

  async function doRoll(expr, label, d20) {
    const e = cleanDice(expr);
    if (!isValidDice(e)) {
      toast('Type dice like 1d20+5 or 2d6+3.', 'error');
      return;
    }
    const mode = d20 || /^1?d20([+-]|$)/.test(e) ? ui.rollMode : 'normal';
    const secret = els.diceForm.secret.checked;
    const row = await guard(() => store.rollDice(s.id, e, { label, mode, private: secret }));
    if (!row) return;
    addRoll(row);
    if (ui.rollMode !== 'normal') {
      ui.rollMode = 'normal';
      drawMode();
    }
  }

  /* --------------------------------------------------------------- actions */
  async function moveToken(t, x, y) {
    t.x = x;
    t.y = y;
    drawBoard();
    await guard(() => store.moveToken(t.id, x, y));
    queueReload(['tokens', 'maps']);
  }

  function nextName(base) {
    const used = new Set(s.tokens.map((t) => t.name));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  async function spawn(payload, x, y) {
    const m = viewMap();
    if (!m || !isDm) return;
    ui.pending = null;
    let fields;
    let secret = null;
    if (payload.type === 'monster') {
      const mon = monsterById(payload.id);
      if (!mon) return;
      let hp = mon.hp?.average ?? null;
      if (ui.rollHp && mon.hp?.formula) {
        try {
          hp = Math.max(1, localRoll(cleanDice(mon.hp.formula)).total);
        } catch {
          /* keep average */
        }
      }
      fields = { kind: 'monster', name: nextName(mon.name), monster_id: mon.id, size: squaresForSize(mon.size), color: '#8b2c2c', hidden: ui.spawnHidden, stats: { speed: walkSpeed(mon.speed) } };
      secret = monsterSecrets(mon, { hp });
    } else if (payload.type === 'pc') {
      const p = member(payload.userId);
      const ch = s.characters[p?.character_id];
      if (!ch) return toast('That player hasn’t chosen a character yet.', 'error');
      fields = { kind: 'pc', name: ch.name, owner_id: p.user_id, character_id: ch.id, size: 1, color: PC_COLOR, hidden: false };
    } else if (payload.type === 'custom') {
      fields = { kind: payload.kind, name: nextName(payload.name), size: payload.size, color: payload.color, hidden: payload.kind === 'monster' && ui.spawnHidden };
      secret = { hp_current: payload.hp, hp_max: payload.hp, ac: payload.ac };
    } else if (payload.type === 'copy') {
      const src = s.tokens.find((t) => t.id === payload.id);
      if (!src) return;
      fields = { kind: src.kind, name: nextName(src.name.replace(/ \d+$/, '')), monster_id: src.monster_id, size: src.size, color: src.color, hidden: src.hidden, owner_id: src.owner_id, character_id: src.character_id };
      const sec = s.secrets[src.id];
      if (sec) {
        secret = { hp_current: sec.hp_max ?? sec.hp_current, hp_max: sec.hp_max, ac: sec.ac, notes: sec.notes, saves: sec.saves, resist: sec.resist, immune: sec.immune, vulnerable: sec.vulnerable, xp: sec.xp };
      }
    } else return;
    const size = fields.size || 1;
    fields = { ...fields, campaign_id: s.id, map_id: m.id, x: Math.min(x, m.cols - size), y: Math.min(y, m.rows - size) };
    const token = await guard(() => store.createToken(fields, secret));
    if (!token) return;
    s.tokens.push(token);
    if (secret) s.secrets[token.id] = { token_id: token.id, ...secret };
    ui.selectedId = token.id;
    if (payload.type === 'pc' && m.vision > 0) {
      // Light up the fog around a newly placed hero.
      await guard(() => store.moveToken(token.id, token.x, token.y));
    }
    if (payload.type === 'pc') await syncParty();
    drawToolbar();
    drawBoard();
    drawSide();
    toast(`${token.name} placed${token.hidden ? ' (hidden from players)' : ''}.`);
  }

  async function paintFog(cells, revealed) {
    const m = viewMap();
    if (!m) return;
    // Apply the brush to the newest fog so we don't undo squares players just revealed.
    m.revealed = setCells(fitFog(m.revealed, m.cols, m.rows), m.cols, m.rows, cells, revealed);
    drawBoard();
    await guard(() => store.updateMap(m.id, { revealed: m.revealed }));
    if (ui.tab === 'maps') drawSide();
  }

  /* ------------------------------------------------------- event wiring */
  root.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      ui.tab = tabBtn.dataset.tab;
      drawSide({ force: true });
      return;
    }
    const toolBtn = e.target.closest('[data-tool]');
    if (toolBtn) {
      ui.tool = toolBtn.dataset.tool;
      board.setTool(ui.tool);
      drawToolbar();
      return;
    }
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      ui.rollMode = modeBtn.dataset.mode;
      drawMode();
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el || busy.has(el)) return;
    const act = el.dataset.act;
    const id = el.dataset.id;
    busy.add(el);
    try {
      await handle(act, el, id);
    } finally {
      busy.delete(el);
    }
  });

  async function handle(act, el, id) {
    switch (act) {
      case 'zoom-in':
        return board.zoomBy(1.25);
      case 'zoom-out':
        return board.zoomBy(0.8);
      case 'find-me': {
        const t = s.tokens.find((x) => x.owner_id === me);
        if (t) board.centerOn(t.x, t.y);
        return;
      }
      case 'invite':
        ui.tab = 'party';
        drawSide({ force: true });
        return copy(inviteLink(s.campaign.join_code), 'Invite link copied. Send it to your players.');
      case 'copy-link':
        return copy(inviteLink(s.campaign.join_code), 'Invite link copied.');
      case 'copy-code':
        return copy(s.campaign.join_code, 'Code copied.');
      case 'new-code': {
        const ok = await confirmDialog({ title: 'Make a new code?', message: 'The old code and link will stop working. Players already in the campaign stay in.', confirmLabel: 'Make new code' });
        if (!ok) return;
        const code = await guard(() => store.newJoinCode(s.id), 'New code made.');
        if (code) s.campaign.join_code = code;
        return drawSide({ force: true });
      }
      case 'place': {
        if (el.dataset.type === 'monster') {
          const mon = monsterById(el.dataset.id);
          ui.pending = { type: 'monster', id: mon.id, name: mon.name };
        } else ui.pending = { type: 'pc', userId: el.dataset.user, name: member(el.dataset.user)?.name };
        drawToolbar();
        drawBoard();
        return;
      }
      case 'cancel-place':
        ui.pending = null;
        drawToolbar();
        return drawBoard();
      case 'remove-player': {
        const ok = await confirmDialog({ title: `Remove ${el.dataset.name}?`, message: 'They can rejoin with the code unless you make a new one.', confirmLabel: 'Remove', danger: true });
        if (ok) await guard(() => store.removePlayer(s.id, el.dataset.user), 'Player removed.');
        return queueReload(['members']);
      }
      case 'delete-campaign': {
        const ok = await confirmDialog({ title: 'Delete this campaign?', message: 'Maps, tokens, images and the roll log will be deleted for everyone. Characters are kept.', confirmLabel: 'Delete campaign', danger: true });
        if (!ok) return;
        await guard(async () => {
          await store.deleteCampaign(s.id);
          navigate('/campaigns');
        }, 'Campaign deleted.');
        return;
      }
      case 'leave': {
        const ok = await confirmDialog({ title: 'Leave this campaign?', message: 'Your character is kept in your library. You can rejoin with the code.', confirmLabel: 'Leave' });
        if (!ok) return;
        await guard(async () => {
          await store.leaveCampaign(s.id, me);
          navigate('/campaigns');
        });
        return;
      }
      case 'view-map':
        ui.viewMapId = id;
        ui.selectedId = null;
        drawToolbar();
        drawBoard();
        return drawSide({ force: true });
      case 'activate-map':
        await guard(() => store.setActiveMap(s.id, id), 'Players can now see this map.');
        s.campaign.active_map_id = id;
        ui.viewMapId = id;
        drawToolbar();
        drawBoard();
        return drawSide({ force: true });
      case 'new-map': {
        const map = await guard(() => store.createMap(s.id, { name: `Map ${s.maps.length + 1}` }));
        if (!map) return;
        s.maps.push(map);
        ui.viewMapId = map.id;
        toast('New map made. Players can’t see it until you open it for them.');
        drawToolbar();
        drawBoard();
        return drawSide({ force: true });
      }
      case 'delete-map': {
        const map = s.maps.find((m) => m.id === id);
        const ok = await confirmDialog({ title: `Delete ${map.name}?`, message: 'Its tokens are removed too.', confirmLabel: 'Delete map', danger: true });
        if (!ok) return;
        await guard(() => store.deleteMap(id), 'Map deleted.');
        ui.viewMapId = null;
        return queueReload(['campaign', 'maps', 'tokens']);
      }
      case 'remove-bg': {
        const m = viewMap();
        await guard(() => store.updateMap(m.id, { background_path: null }));
        m.background_path = null;
        drawBoard();
        return drawSide({ force: true });
      }
      case 'fog-all': {
        const m = viewMap();
        const ok = await confirmDialog({ title: el.dataset.value === '1' ? 'Reveal the whole map?' : 'Cover the whole map in fog?', message: 'Players will see the change right away.', confirmLabel: 'Yes' });
        if (!ok) return;
        m.revealed = el.dataset.value.repeat(m.cols * m.rows);
        drawBoard();
        await guard(() => store.updateMap(m.id, { revealed: m.revealed }));
        return drawSide({ force: true });
      }
      case 'show-handout': {
        const shown = el.dataset.shown === '1';
        await guard(() => store.showHandout(id, shown), shown ? 'Your players can see it now.' : 'Hidden from players.');
        return queueReload(['handouts']);
      }
      case 'delete-handout': {
        const h = s.handouts.find((x) => x.id === id);
        const ok = await confirmDialog({ title: 'Delete this image?', message: h.title || 'Untitled image', confirmLabel: 'Delete', danger: true });
        if (ok) await guard(() => store.deleteHandout(h));
        return queueReload(['handouts']);
      }
      case 'open-handout':
        return openHandout(s.handouts.find((x) => x.id === id));
      case 'toggle-hidden': {
        const t = selected();
        t.hidden = !t.hidden;
        drawBoard();
        drawSide({ force: true });
        await guard(() => store.updateToken(t.id, { hidden: t.hidden }), t.hidden ? `${t.name} is hidden.` : `${t.name} is visible to players.`);
        return;
      }
      case 'duplicate-token': {
        const t = selected();
        const m = viewMap();
        return spawn({ type: 'copy', id: t.id }, Math.min(t.x + t.size, m.cols - t.size), t.y);
      }
      case 'delete-token': {
        const t = selected();
        s.tokens = s.tokens.filter((x) => x.id !== t.id);
        ui.selectedId = null;
        drawBoard();
        drawSide({ force: true });
        await guard(() => store.deleteToken(t.id), `${t.name} removed.`);
        return;
      }
      case 'combat-start': {
        await guard(() => store.combat.start(s.id), 'Combat! Roll initiative.');
        return reloadNow(['campaign', 'tokens']);
      }
      case 'combat-end': {
        const ok = await confirmDialog({ title: 'End combat?', message: 'Clears the turn order. You can give out XP from the Party tab.', confirmLabel: 'End combat' });
        if (!ok) return;
        await guard(() => store.combat.end(s.id), 'Combat over.');
        ui.tab = 'party';
        return reloadNow(['campaign', 'tokens']);
      }
      case 'next-turn':
        await guard(() => store.combat.next(s.id));
        return reloadNow(['campaign', 'tokens']);
      case 'init-enemies': {
        const m = activeMap();
        const list = s.tokens.filter((t) => m && t.map_id === m.id && t.kind !== 'pc' && t.initiative == null && !(t.conditions || []).includes('Dead'));
        if (!list.length) return toast('Every enemy on this map already has initiative.');
        for (const t of list) await guard(() => store.combat.initiative(t.id, initiativeBonus(t)));
        toast(`Rolled initiative for ${list.length} creature${list.length > 1 ? 's' : ''}.`);
        return reloadNow(['tokens']);
      }
      case 'my-initiative': {
        const t = myToken();
        if (!t) return toast('Your DM needs to place your token first.', 'error');
        const total = await guard(() => store.combat.initiative(t.id, initiativeBonus(t), takeMode()));
        if (total != null) toast(`Initiative: ${total}`);
        return reloadNow(['tokens']);
      }
      case 'token-initiative': {
        const t = selected();
        await guard(() => store.combat.initiative(t.id, initiativeBonus(t), takeMode()));
        return reloadNow(['tokens']);
      }
      case 'attack-weapon': {
        const ch = myCharacter();
        const d = derive(ch.data, rules);
        const a = d.attacks.find((x) => x.uid === el.dataset.uid);
        const tok = myToken();
        if (!a || !tok) return;
        const bonus = el.dataset.bonus === '1';
        // An off-hand Light weapon adds no ability modifier to its damage (unless it's negative).
        const damage = bonus && a.uid !== 'unarmed' ? offHandDamage(a.damage) : a.damage;
        return startTarget({
          label: bonus ? `${a.name} (bonus action)` : a.name,
          run: ([target]) => store.combat.attack({ attacker: tok.id, target, bonus: a.toHit - d.d20Penalty, damage, damageType: a.damageType, mode: takeMode(), label: a.name, use: bonus ? 'bonus' : 'attack' }),
        });
      }
      case 'monster-action': {
        const t = selected();
        const mon = t && monsterById(t.monster_id);
        const a = mon && monsterActions(mon)[Number(el.dataset.index)];
        if (!a) return;
        if (a.kind === 'attack') {
          return startTarget({
            label: `${t.name}: ${a.name}`,
            run: ([target]) => store.combat.attack({ attacker: t.id, target, bonus: a.bonus, damage: a.damage, damageType: a.damageType, extra: a.extra, mode: takeMode(), label: a.name, use: 'attack' }),
          });
        }
        return startTarget({
          label: `${t.name}: ${a.name}`,
          multi: true,
          run: (targets) => store.combat.save({ source: t.id, targets, ability: a.save, dc: a.dc, damage: a.damage, damageType: a.damageType, half: a.half, condition: a.condition, label: a.name }),
        });
      }
      case 'cast': {
        const sel = els.body.querySelector(`#slot-${CSS.escape(el.dataset.spell)}`);
        return cast(el.dataset.spell, Number(sel?.value ?? el.dataset.slot));
      }
      case 'confirm-targets': {
        const tg = ui.target;
        if (!tg?.targets.length && !tg?.area) return;
        ui.target = null;
        drawToolbar();
        drawBoard();
        return resolveTarget(tg, tg.targets);
      }
      case 'cancel-target':
        ui.target = null;
        drawToolbar();
        return drawBoard();
      case 'undo-target':
        if (ui.target) ui.target.targets = ui.target.targets.slice(0, -1);
        drawToolbar();
        return drawBoard();
      case 'cancel-aim':
        ui.aim = null;
        drawToolbar();
        return drawBoard();
      case 'turn-action': {
        const t = isDm ? s.tokens.find((x) => x.id === s.campaign.combat_turn) : myToken();
        if (!t) return;
        const what = el.dataset.what;
        const res = await guard(() => store.combat.action(t.id, what, { use: el.dataset.use === 'free' ? 'action' : el.dataset.use }));
        if (res?.kind === 'heal') toast(`${t.name} regains ${res.amount} hit points.`, 'success');
        else if (res && what === 'dash') toast(`Dash: ${speedOf(t)} more feet of movement this turn.`, 'success');
        return reloadNow(['tokens', 'members']);
      }
      case 'toggle-condition': {
        const t = selected();
        const name = el.dataset.name;
        await guard(() => store.combat.condition(t.id, name, !(t.conditions || []).includes(name)));
        return reloadNow(['tokens', 'members']);
      }
      case 'my-condition': {
        const t = myToken();
        const ch = myCharacter();
        if (!t || !ch) return;
        const name = el.dataset.name;
        await guard(() => store.combat.condition(t.id, name, !(ch.data.conditions || []).includes(name)));
        return reloadNow(['tokens', 'members']);
      }
      case 'death-save': {
        const res = await guard(() => store.combat.deathSave(myToken().id));
        if (res) toast(`Death save: rolled ${res.roll}. ${res.outcome}.`, res.roll >= 10 ? 'success' : 'error');
        return reloadNow(['members', 'tokens']);
      }
      case 'hit-die': {
        const ch = myCharacter();
        const d = derive(ch.data, rules);
        const res = await guard(() => store.combat.hitDie(myToken().id, d.hitDie, d.mods.con));
        if (res) toast(`Healed ${res.healed} HP.`, 'success');
        return reloadNow(['members']);
      }
      case 'rest': {
        const long = el.dataset.kind === 'long';
        const ok = await confirmDialog({
          title: long ? 'Long rest for the party?' : 'Short rest for the party?',
          message: long ? 'Everyone gets back all HP, spell slots and Hit Dice, and loses one level of Exhaustion.' : 'Warlocks get their spell slots back. Players can spend Hit Dice to heal.',
          confirmLabel: long ? 'Long rest' : 'Short rest',
        });
        if (!ok) return;
        await guard(() => store.combat.rest(s.id, long ? 'long' : 'short'), long ? 'The party is rested.' : 'Short rest taken.');
        return reloadNow(['members']);
      }
      case 'roll':
        return doRoll(el.dataset.expr, el.dataset.label, el.dataset.d20 === '1');
      case 'quick-die':
        return doRoll(`1d${el.dataset.die}`, `d${el.dataset.die}`, el.dataset.die === '20');
      case 'choose-character':
        await guard(() => store.chooseCharacter(s.id, me, id), 'Character chosen. Your DM can now place you on the map.');
        ui.changingCharacter = false;
        return queueReload(['members']);
      case 'change-character':
        ui.changingCharacter = true;
        ui.myCharacters = null;
        return drawSide({ force: true });
      case 'cancel-change':
        ui.changingCharacter = false;
        return drawSide({ force: true });
      default:
    }
  }

  async function copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message, 'success');
    } catch {
      window.prompt('Copy this:', text);
    }
  }

  // Dragging enemies and party members onto the map.
  root.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.('[data-drag]');
    if (!el) return;
    e.dataTransfer.setData(DRAG_TYPE, el.dataset.drag);
    e.dataTransfer.setData('text/plain', el.textContent.trim().split('\n')[0]);
    e.dataTransfer.effectAllowed = 'copy';
  });

  root.addEventListener('input', (e) => {
    const k = e.target.dataset.input;
    if (k === 'search') {
      ui.search = e.target.value;
      redrawSearch();
    }
  });
  const redrawSearch = debounce(() => {
    const input = els.body.querySelector('#monster-search');
    const pos = input?.selectionStart;
    drawSide({ force: true });
    const again = els.body.querySelector('#monster-search');
    if (again) {
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  }, 150);

  root.addEventListener('change', async (e) => {
    const k = e.target.dataset.input;
    if (k === 'spawn-hidden') ui.spawnHidden = e.target.checked;
    if (k === 'roll-hp') ui.rollHp = e.target.checked;
    if (e.target.dataset.act === 'brush') {
      ui.brush = Number(e.target.value);
      board.setBrush(ui.brush);
    }
    if (k === 'map-bg') {
      const file = e.target.files[0];
      const m = viewMap();
      if (!file || !m) return;
      toast('Uploading…');
      const path = await guard(() => store.uploadImage(s.id, file));
      if (!path) return;
      await guard(() => store.updateMap(m.id, { background_path: path }), 'Background added.');
      m.background_path = path;
      drawBoard();
      drawSide({ force: true });
    }
    if (e.target.name === 'file' && e.target.closest('[data-form=handout]')) {
      e.target.closest('form').querySelector('.file-name').textContent = e.target.files[0]?.name || '';
    }
  });

  root.addEventListener('focusout', () => {
    // Catch up on changes that arrived while someone was typing.
    setTimeout(() => {
      if (ui.sideDirty && !els.body.contains(document.activeElement)) drawSide();
    }, 0);
  });

  root.addEventListener('submit', async (e) => {
    const form = e.target;
    e.preventDefault();
    const f = new FormData(form);
    const num = (k) => (f.get(k) === '' || f.get(k) == null ? null : Number(f.get(k)));
    if (form === els.diceForm) {
      const expr = f.get('expr');
      if (!String(expr).trim()) return;
      await doRoll(expr, '', false);
      form.expr.select();
      return;
    }
    const kind = form.dataset.form;
    const btn = form.querySelector('button:not([type=button])');
    if (btn) btn.disabled = true;
    try {
      if (kind === 'custom-token') {
        const payload = { type: 'custom', name: String(f.get('name')).trim(), kind: f.get('kind'), size: Number(f.get('size')), hp: num('hp'), ac: num('ac'), color: f.get('color') };
        ui.pending = payload;
        document.activeElement?.blur();
        drawToolbar();
        drawBoard();
        toast('Now click a square on the map.');
      } else if (kind === 'map') {
        const m = viewMap();
        const fields = { name: String(f.get('name')).trim(), cols: num('cols'), rows: num('rows'), vision: num('vision') };
        await guard(() => store.updateMap(m.id, fields), 'Map saved.');
        document.activeElement?.blur();
        await reloadNow(['maps', 'tokens']);
      } else if (kind === 'handout') {
        const file = form.file.files[0];
        if (!file) return toast('Choose an image first.', 'error');
        toast('Uploading…');
        const path = await guard(() => store.uploadImage(s.id, file));
        if (!path) return;
        await guard(() => store.createHandout(s.id, String(f.get('title')).trim(), path), 'Image added. Press “Show to players” when the moment comes.');
        form.reset();
        document.activeElement?.blur();
        await reloadNow(['handouts']);
      } else if (kind === 'token') {
        const t = selected();
        const fields = { name: String(f.get('name')).trim() || t.name, color: f.get('color'), size: Number(f.get('size')) };
        await guard(() => store.updateToken(t.id, fields));
        if (t.kind !== 'pc') {
          await guard(() => store.saveSecret(t.id, s.id, { hp_current: num('hp_current'), hp_max: num('hp_max'), ac: num('ac'), notes: f.get('notes') || null }));
        }
        toast('Saved.', 'success');
        document.activeElement?.blur();
        await reloadNow(['tokens']);
      } else if (kind === 'hp-change' || kind === 'my-hp') {
        const t = kind === 'my-hp' ? myToken() : selected();
        if (!t) return;
        const amount = num('amount') || 0;
        const how = e.submitter?.value || 'damage';
        const res = await guard(() => store.combat.adjustHp(t.id, how === 'heal' ? amount : how === 'temp' ? amount : -amount, how === 'temp'));
        if (res) {
          if (how === 'temp') toast(`${t.name} has ${res.temp} temporary HP.`);
          else toast(res.dead ? `${t.name} has died.` : res.down ? `${t.name} is down!` : `${t.name}: ${res.hp} HP`, res.down ? 'success' : '');
        }
        form.reset();
        document.activeElement?.blur();
        await reloadNow(['tokens', 'members']);
      } else if (kind === 'xp') {
        const amount = num('amount') || 0;
        const each = await guard(() => store.combat.awardXp(s.id, amount));
        if (each) toast(`Each character gains ${each} XP.`, 'success');
        form.reset();
        document.activeElement?.blur();
        await reloadNow(['members']);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  /* ------------------------------------------------------------ handouts */
  async function openHandout(h) {
    if (!h) return;
    const url = await store.imageUrl(h.image_path);
    if (!url) return toast('That image isn’t available.', 'error');
    document.querySelector('dialog.handout-dialog')?.close();
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog handout-dialog';
    dlg.innerHTML = String(html`<form method="dialog">
      <h2>${h.title || 'From your DM'}</h2>
      <img src="${url}" alt="${h.title || 'Image from the DM'}">
      <div class="dialog-actions"><button class="button">Close</button></div></form>`);
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }

  async function loadThumbs() {
    for (const img of els.body.querySelectorAll('img[data-img]')) {
      const url = await store.imageUrl(img.dataset.img);
      if (url) img.src = url;
    }
  }
  new MutationObserver(loadThumbs).observe(els.body, { childList: true });

  function checkNewHandouts() {
    if (isDm) return;
    let newest = null;
    for (const h of s.handouts) {
      if (!h.shown) continue;
      if (ui.seenHandouts.get(h.id) !== h.shown_at) {
        ui.seenHandouts.set(h.id, h.shown_at);
        if (!newest || h.shown_at > newest.shown_at) newest = h;
      }
    }
    if (newest) openHandout(newest);
  }

  /* --------------------------------------------------- live updates */
  let queued = new Set();
  let reloading = false;
  const runReload = debounce(async () => {
    if (reloading) return runReload();
    const parts = [...queued];
    queued = new Set();
    if (!parts.length) return;
    reloading = true;
    try {
      await reloadNow(parts);
    } finally {
      reloading = false;
    }
  }, 120);

  function queueReload(parts) {
    for (const p of parts) queued.add(p);
    runReload();
  }

  async function reloadNow(parts) {
    let ok;
    try {
      ok = await store.reload(s, parts);
    } catch (err) {
      console.error(err);
      return;
    }
    if (!ok) {
      if (ui.gone) return;
      ui.gone = true;
      root.innerHTML = String(html`<section class="page narrow"><div class="card">
        <h1>You’re no longer in this campaign</h1>
        <p>The campaign was deleted or the DM removed you.</p>
        <p><a class="button" href="#/campaigns">Back to campaigns</a></p></div></section>`);
      return;
    }
    if (ui.selectedId && !s.tokens.some((t) => t.id === ui.selectedId)) ui.selectedId = null;
    if (ui.viewMapId && !s.maps.some((m) => m.id === ui.viewMapId)) ui.viewMapId = null;
    els.title.textContent = s.campaign.name;
    checkTurn();
    drawCombat();
    drawToolbar();
    drawBoard();
    drawSide();
    if (parts.includes('handouts')) checkNewHandouts();
    if (isDm && (parts.includes('members') || parts.includes('tokens'))) syncParty();
  }

  const unsubscribe = store.subscribe(s.id, {
    onChange: queueReload,
    onRoll(row) {
      addRoll(row);
      rememberArea(row);
      if (row.user_id !== me) {
        const kind = row.result?.kind;
        const text = `${row.roller_name}: ${row.label || row.expr}`;
        toast(['rest', 'xp', 'save', 'action'].includes(kind) ? text : `${text} = ${row.total}`);
      }
    },
    onStatus(status) {
      const wasLive = ui.live === 'SUBSCRIBED';
      ui.live = status;
      drawLive();
      // Catch up on anything missed while the connection was down.
      if (status === 'SUBSCRIBED' && !wasLive) queueReload(['campaign', 'members', 'maps', 'tokens', 'handouts', 'rolls']);
    },
  });
  // A safety net in case the live connection quietly drops.
  const poll = setInterval(() => {
    if (document.visibilityState === 'visible') queueReload(['campaign', 'members', 'maps', 'tokens', 'handouts']);
  }, 30000);

  drawAll();
  if (!isDm) {
    const mine = s.tokens.find((t) => t.owner_id === me);
    if (mine) board.centerOn(mine.x, mine.y);
  }

  return () => {
    unsubscribe();
    clearInterval(poll);
    document.querySelector('dialog.handout-dialog')?.remove();
  };
}

/** "1d6+3" -> "1d6": an off-hand attack adds no positive ability modifier. */
function offHandDamage(dmg) {
  return String(dmg).replace(/\+\d+$/, '');
}

/** JSON with sorted keys, to compare objects that came back from the database. */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
