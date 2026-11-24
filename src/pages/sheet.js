// Digital character sheet. Every change saves automatically, and every number
// you'd normally roll for can be clicked to roll it.
import { html, raw, rulesMarkdown, debounce } from '../lib/dom.js';
import { loadCharacterRules, spellLevelLabel } from '../lib/srd.js';
import {
  ABILITIES,
  ABILITY_LABELS,
  derive,
  signed,
  applyDamage,
  applyHealing,
  applyTempHp,
  longRest,
  shortRest,
  uid,
} from '../lib/character/rules.js';
import { getCharacter, saveCharacter, downloadCharacter } from '../lib/character/store.js';
import { canLevelUp, XP_FOR_LEVEL } from '../lib/character/automation.js';
import { levelUpDialog } from '../components/levelup.js';
import { roll, d20, critical, describe } from '../lib/dice.js';
import { confirmDialog, toast } from '../lib/ui.js';

const md = (t) => raw(rulesMarkdown(t));
const CONDITIONS = [
  'Blinded',
  'Charmed',
  'Deafened',
  'Frightened',
  'Grappled',
  'Incapacitated',
  'Invisible',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Restrained',
  'Stunned',
  'Unconscious',
];
const TABS = [
  ['combat', 'Combat'],
  ['spells', 'Spells'],
  ['features', 'Features'],
  ['inventory', 'Inventory'],
  ['notes', 'Notes'],
];

export async function renderSheet(root, { params }) {
  const id = params[0];
  root.innerHTML = '<p class="loading">Loading character…</p>';
  const [srd, row] = await Promise.all([loadCharacterRules(), getCharacter(id)]);
  if (!row) {
    root.innerHTML = String(html`<section class="page narrow"><h1>Character not found</h1><p>It may have been deleted. <a href="#/characters">Back to your characters</a></p></section>`);
    return;
  }

  let c = row.data;
  let updatedAt = row.updated_at;
  let tab = sessionStorage.getItem('sheetTab') || 'combat';
  let mode = 'normal'; // advantage / disadvantage for the next d20 rolls
  const log = [];
  let saveState = 'saved';
  let itemSearch = '';

  /* ------------------------------------------------------------ saving */
  const persist = debounce(async () => {
    setSaveState('saving');
    try {
      const res = await saveCharacter(id, c, updatedAt);
      if (res.conflict) {
        // Changed somewhere else (e.g. took damage at the live table): show the latest.
        await refresh();
        toast('This character was just updated at the table, so the sheet now shows the latest. Please redo your last change.');
        return;
      }
      updatedAt = res.updated_at;
      setSaveState('saved');
    } catch (err) {
      setSaveState('error', err.message);
    }
  }, 600);

  async function refresh() {
    const latest = await getCharacter(id);
    if (!latest) return;
    c = latest.data;
    updatedAt = latest.updated_at;
    setSaveState('saved');
    draw();
  }

  // Coming back to this tab: pick up anything that happened at the table.
  const onVisible = async () => {
    if (document.visibilityState !== 'visible' || saveState === 'saving') return;
    persist.flush();
    const latest = await getCharacter(id).catch(() => null);
    if (latest && latest.updated_at !== updatedAt && saveState === 'saved') {
      c = latest.data;
      updatedAt = latest.updated_at;
      draw();
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  function setSaveState(state, message = '') {
    saveState = state;
    const el = root.querySelector('.save-state');
    if (!el) return;
    el.dataset.state = state;
    el.textContent = state === 'saving' ? 'Saving…' : state === 'error' ? `Not saved: ${message}` : 'All changes saved';
  }

  function update(next, { redraw = true } = {}) {
    c = next;
    persist();
    if (redraw) draw();
  }

  /* ------------------------------------------------------------ rolling */
  function doRoll(label, expr, { d20Test = false } = {}) {
    const d = derive(c, srd);
    let e = expr;
    if (d20Test && d.d20Penalty) e = `${expr}-${d.d20Penalty}`;
    const r = roll(e, { mode: d20Test ? mode : 'normal' });
    const entry = { id: uid(), label, result: r, d20Test, at: new Date() };
    log.unshift(entry);
    log.length = Math.min(log.length, 30);
    if (d20Test && mode !== 'normal') {
      mode = 'normal';
      drawModeButtons();
    }
    drawLog();
    const crit = d20Test && r.natural === 20 ? ' Natural 20!' : d20Test && r.natural === 1 ? ' Natural 1.' : '';
    toast(`${label}: ${r.total}${crit}`, r.natural === 20 ? 'success' : '');
    return r;
  }

  /* ------------------------------------------------------------ layout */
  function draw() {
    const d = derive(c, srd);
    const y = window.scrollY;
    const focusedId = document.activeElement?.id;
    root.innerHTML = String(html`
      <section class="sheet page">
        <header class="sheet-head card">
          <div>
            <h1>${c.name}</h1>
            <p class="muted">${[d.species?.name + (c.speciesOptions?.lineage ? ` (${c.speciesOptions.lineage})` : ''), d.background?.name, d.cls ? `${d.cls.name} ${d.level}` : null, d.subclass?.name].filter(Boolean).join(' · ')}</p>
            <p class="xp-line">${c.level >= 20 ? html`${(Number(c.xp) || 0).toLocaleString()} XP` : html`${(Number(c.xp) || 0).toLocaleString()} / ${XP_FOR_LEVEL[(Number(c.level) || 1) + 1].toLocaleString()} XP to level ${(Number(c.level) || 1) + 1}`}
              ${c.level < 20 ? html`<button type="button" class="button small ${canLevelUp(c) ? '' : 'secondary'}" data-act="level-up">${canLevelUp(c) ? '★ Level up!' : 'Level up'}</button>` : ''}</p>
            <p class="save-state" data-state="${saveState}" role="status" aria-live="polite">All changes saved</p>
          </div>
          <div class="head-actions">
            <button type="button" class="button small secondary" data-act="short-rest">Short rest</button>
            <button type="button" class="button small secondary" data-act="long-rest">Long rest</button>
            <a class="button small secondary" href="#/characters/${id}/edit">Edit in builder</a>
            <button type="button" class="button small secondary" data-act="export">Export file</button>
          </div>
        </header>

        <div class="sheet-grid">
          <div class="sheet-left">
            <section class="card abilities-card" aria-label="Ability scores">
              ${ABILITIES.map(
                (a) => html`<div class="ability-box">
                  <span class="ab-name">${ABILITY_LABELS[a]}</span>
                  <button type="button" class="ab-mod" data-roll="check" data-ability="${a}" title="Roll a ${ABILITY_LABELS[a]} check">${signed(d.mods[a])}</button>
                  <span class="ab-score">${d.scores[a]}</span>
                  <button type="button" class="ab-save ${d.saves[a].proficient ? 'prof' : ''}" data-roll="save" data-ability="${a}" title="Roll a ${ABILITY_LABELS[a]} saving throw">Save ${signed(d.saves[a].bonus)}</button>
                </div>`,
              )}
            </section>
            <section class="card">
              <h2>Skills</h2>
              <ul class="skill-list">
                ${Object.entries(d.skills).map(
                  ([name, s]) => html`<li><button type="button" data-roll="skill" data-skill="${name}">
                    <span class="dot ${s.expertise ? 'exp' : s.proficient ? 'prof' : ''}" aria-label="${s.expertise ? 'Expertise' : s.proficient ? 'Proficient' : 'Not proficient'}"></span>
                    <span class="sk-name">${name} <small class="muted">${s.ability.toUpperCase()}</small></span>
                    <span class="sk-bonus">${signed(s.bonus)}</span>
                  </button></li>`,
                )}
              </ul>
              <p class="muted small">Passive Perception ${d.passivePerception}</p>
            </section>
          </div>

          <div class="sheet-main">
            <section class="card vitals">
              <div class="vital"><span class="v-label">Armor Class</span><span class="v-num">${d.ac}</span><span class="v-sub">${d.acSource}</span></div>
              <button type="button" class="vital" data-roll="initiative"><span class="v-label">Initiative</span><span class="v-num">${signed(d.initiative)}</span><span class="v-sub">Click to roll</span></button>
              <div class="vital"><span class="v-label">Speed</span><span class="v-num">${d.speed}</span><span class="v-sub">feet</span></div>
              <div class="vital"><span class="v-label">Proficiency</span><span class="v-num">${signed(d.pb)}</span><span class="v-sub">bonus</span></div>
              <button type="button" class="vital ${c.heroicInspiration ? 'on' : ''}" data-act="inspiration" aria-pressed="${!!c.heroicInspiration}"><span class="v-label">Heroic Inspiration</span><span class="v-num">${c.heroicInspiration ? '★' : '☆'}</span><span class="v-sub">${c.heroicInspiration ? 'Have it' : 'None'}</span></button>
            </section>

            <section class="card hp-card" aria-label="Hit points">
              <div class="hp-numbers">
                <div><span class="v-label">Hit Points</span><span class="hp-big ${c.hp.current === 0 ? 'down' : ''}">${c.hp.current ?? d.hpMax}</span><span class="muted">/ ${d.hpMax}</span></div>
                <div><span class="v-label">Temporary</span><span class="hp-big">${c.hp.temp || 0}</span></div>
                <div><span class="v-label">Hit Point Dice</span><span class="hp-big">${d.level - (c.hitDiceSpent || 0)}</span><span class="muted">/ ${d.level} d${d.hitDie}</span></div>
              </div>
              <div class="hp-controls">
                <label class="sr-only" for="hp-amount">Amount</label>
                <input id="hp-amount" type="number" min="0" inputmode="numeric" placeholder="Amount" />
                <button type="button" class="button small danger" data-act="damage">Damage</button>
                <button type="button" class="button small" data-act="heal">Heal</button>
                <button type="button" class="button small secondary" data-act="temp">Set temp HP</button>
                <button type="button" class="button small secondary" data-act="hit-die" ${raw(d.level - (c.hitDiceSpent || 0) <= 0 ? 'disabled' : '')}>Spend a Hit Point Die</button>
              </div>
              ${c.hp.current === 0
                ? html`<div class="death-saves">
                    <span>Death saves:</span>
                    <span>Successes ${pips(c.deathSaves.successes, 3, 'ds-success')}</span>
                    <span>Failures ${pips(c.deathSaves.failures, 3, 'ds-failure')}</span>
                    <button type="button" class="button small" data-roll="death">Roll death save</button>
                  </div>`
                : ''}
              <div class="conditions">
                ${CONDITIONS.map((n) => html`<button type="button" class="chip ${c.conditions.includes(n) ? 'on' : ''}" data-condition="${n}" aria-pressed="${c.conditions.includes(n)}">${n}</button>`)}
                <label class="chip exhaustion">Exhaustion
                  <select data-field="exhaustion" aria-label="Exhaustion level">${[0, 1, 2, 3, 4, 5, 6].map((n) => html`<option value="${n}" ${raw((c.exhaustion || 0) === n ? 'selected' : '')}>${n}</option>`)}</select>
                </label>
              </div>
            </section>

            <div class="roll-mode" role="radiogroup" aria-label="Next d20 roll"></div>

            <nav class="tabs" role="tablist">
              ${TABS.filter(([t]) => t !== 'spells' || d.spell).map(([t, l]) => html`<button type="button" role="tab" aria-selected="${tab === t}" data-tab="${t}">${l}</button>`)}
            </nav>
            <section class="card tab-panel" role="tabpanel">${raw(renderTab(d))}</section>
          </div>

          <aside class="sheet-log card" aria-label="Roll log">
            <h2>Rolls</h2>
            <ol class="log"></ol>
            <form class="custom-roll" autocomplete="off">
              <label for="custom-expr">Roll any dice</label>
              <div class="row"><input id="custom-expr" placeholder="e.g. 2d6+3" /><button class="button small">Roll</button></div>
            </form>
          </aside>
        </div>
      </section>`);
    drawModeButtons();
    drawLog();
    setSaveState(saveState);
    window.scrollTo(0, y);
    if (focusedId) document.getElementById(focusedId)?.focus();
  }

  function pips(n, max, cls) {
    return html`<span class="pips">${Array.from({ length: max }, (_, i) => html`<button type="button" class="pip ${i < n ? 'on' : ''}" data-pip="${cls}" data-index="${i}" aria-label="${cls.replace('ds-', '')} ${i + 1}"></button>`)}</span>`;
  }

  function drawModeButtons() {
    const host = root.querySelector('.roll-mode');
    if (!host) return;
    host.innerHTML = String(
      html`<span class="muted">Next d20 roll:</span>${[
        ['normal', 'Normal'],
        ['advantage', 'Advantage'],
        ['disadvantage', 'Disadvantage'],
      ].map(([v, l]) => html`<button type="button" role="radio" aria-checked="${mode === v}" class="${mode === v ? 'selected' : ''}" data-mode="${v}">${l}</button>`)}`,
    );
  }

  function drawLog() {
    const host = root.querySelector('.log');
    if (!host) return;
    host.innerHTML = log.length
      ? String(
          html`${log.map(
            (e) => html`<li class="${e.result.natural === 20 ? 'nat20' : e.result.natural === 1 ? 'nat1' : ''}">
              <span class="log-label">${e.label}${e.result.mode !== 'normal' ? html` <small>(${e.result.mode})</small>` : ''}</span>
              <span class="log-total">${e.result.total}</span>
              <span class="log-detail">${e.result.expr}: ${describe(e.result)}</span>
            </li>`,
          )}`,
        )
      : '<li class="muted">Click any bonus on the sheet to roll it.</li>';
  }

  /* ------------------------------------------------------------ tabs */
  function renderTab(d) {
    if (tab === 'spells' && d.spell) return spellsTab(d);
    if (tab === 'features') return featuresTab(d);
    if (tab === 'inventory') return inventoryTab(d);
    if (tab === 'notes') return notesTab();
    return combatTab(d);
  }

  function combatTab(d) {
    return String(html`
      <h2>Attacks</h2>
      <table class="attacks">
        <thead><tr><th>Weapon</th><th>To hit</th><th>Damage</th><th>Notes</th></tr></thead>
        <tbody>
          ${d.attacks.map(
            (a) => html`<tr>
              <th scope="row">${a.name}${a.proficient ? '' : html` <small class="muted">(not proficient)</small>`}</th>
              <td><button type="button" class="roll-btn" data-roll="attack" data-attack="${a.uid}">${signed(a.toHit)}</button></td>
              <td><button type="button" class="roll-btn" data-roll="damage" data-attack="${a.uid}">${a.damage}</button> ${a.damageType}
                <button type="button" class="link-button small" data-roll="crit" data-attack="${a.uid}" title="Critical Hit: roll the damage dice twice">crit</button></td>
              <td class="muted small">${[...a.properties, a.mastery ? `Mastery: ${a.mastery}` : null].filter(Boolean).join(', ')}</td>
            </tr>`,
          )}
        </tbody>
      </table>
      <p class="hint">Equip or unequip weapons on the Inventory tab.</p>
      ${d.classRow && d.cls
        ? html`<h2>${d.cls.name} at level ${d.level}</h2>
          <dl class="facts">${Object.entries(d.classRow)
            .filter(([k, v]) => !['Level', 'Proficiency Bonus', 'Class Features', 'slots'].includes(k) && v && v !== '—')
            .map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`
        : ''}`);
  }

  function spellsTab(d) {
    const s = d.spell;
    const byId = (sid) => srd.spells.find((x) => x.id === sid);
    const chosen = [...c.spells.cantrips, ...c.spells.prepared].map(byId).filter(Boolean);
    const known = [...chosen, ...d.alwaysSpells.filter((x) => !chosen.includes(x))];
    const levels = [...new Set(known.map((x) => x.level))].sort((a, b) => a - b);
    return String(html`
      <div class="spell-head">
        <div class="vital"><span class="v-label">Spell save DC</span><span class="v-num">${s.saveDc}</span></div>
        <button type="button" class="vital" data-roll="spell-attack"><span class="v-label">Spell attack</span><span class="v-num">${signed(s.attack)}</span></button>
        <div class="vital"><span class="v-label">Ability</span><span class="v-num">${s.ability.toUpperCase()}</span></div>
      </div>
      <h2>Spell slots${s.pact ? ' (Pact Magic, back on a Short Rest)' : ''}</h2>
      <div class="slots">
        ${Object.entries(s.slots).map(([lvl, n]) => {
          const used = c.slotsUsed?.[lvl] || 0;
          return html`<div class="slot-row"><span>${spellLevelLabel(Number(lvl))}</span>
            <span class="pips">${Array.from({ length: n }, (_, i) => html`<button type="button" class="pip slot ${i < used ? 'used' : ''}" data-slot="${lvl}" data-index="${i}" aria-label="${spellLevelLabel(Number(lvl))} slot ${i + 1}${i < used ? ' (used)' : ''}"></button>`)}</span>
            <span class="muted small">${n - used} left</span></div>`;
        })}
      </div>
      <p class="hint">Click a slot to mark it used. A Long Rest restores them.</p>
      ${levels.map(
        (lvl) => html`<h3>${lvl === 0 ? 'Cantrips' : spellLevelLabel(lvl)}</h3>
          ${known.filter((x) => x.level === lvl).map(
            (x) => html`<details class="spell"><summary><strong>${x.name}</strong> <small class="muted">${x.castingTime} · ${x.range}${x.concentration ? ' · Concentration' : ''}${x.ritual ? ' · Ritual' : ''}${d.alwaysSpells.includes(x) ? ' · Always prepared' : ''}</small></summary>
              <p class="muted">${spellLevelLabel(x.level)} ${x.school} · Components: ${x.components.raw} · Duration: ${x.duration}${x.source && x.source !== 'srd' ? ` · ${x.sourceName}` : ''}</p>
              ${md(x.description)}
              ${x.higherLevels ? html`<p><strong><em>Using a Higher-Level Spell Slot.</em></strong> ${x.higherLevels}</p>` : ''}
              ${x.cantripUpgrade ? html`<p><strong><em>Cantrip Upgrade.</em></strong> ${x.cantripUpgrade}</p>` : ''}
            </details>`,
          )}`,
      )}
      ${!known.length ? html`<p class="muted">No spells chosen yet.</p>` : ''}
      ${d.alwaysMissing.length ? html`<p class="hint">Your subclass also lists ${d.alwaysMissing.join(', ')}, which ${d.alwaysMissing.length === 1 ? "isn't" : "aren't"} in this site's open-licensed rules. Ask your DM for a stand-in.</p>` : ''}
      <p><a href="#/characters/${id}/edit">Change spells in the builder</a></p>`);
  }

  function featuresTab(d) {
    const block = (title, items, nameOf = (x) => x.name, textOf = (x) => x.description) =>
      items.length
        ? html`<h2>${title}</h2>${items.map((f) => html`<details><summary>${nameOf(f)}</summary>${md(textOf(f))}</details>`)}`
        : '';
    return String(html`
      ${block(`${d.cls?.name || 'Class'} features`, d.features.filter((f) => f.source === d.cls?.name), (f) => `Level ${f.level}: ${f.name}`)}
      ${d.subclass ? block(`${d.subclass.name} features`, d.features.filter((f) => f.source === d.subclass.name), (f) => `Level ${f.level}: ${f.name}`) : ''}
      ${block(`${d.species?.name || 'Species'} traits`, d.speciesTraits, (t) => t.name, (t) => t.text)}
      ${block('Feats', d.feats)}
      <h2>Proficiencies</h2>
      <dl class="facts">
        <dt>Weapons</dt><dd>${d.cls?.weaponProficiencies || '—'}</dd>
        <dt>Armor</dt><dd>${d.cls?.armorTraining || 'None'}</dd>
        <dt>Tools</dt><dd>${[d.cls?.toolProficiencies, d.background?.toolProficiency].filter(Boolean).join('; ') || '—'}</dd>
      </dl>`);
  }

  function inventoryTab() {
    const q = itemSearch.trim().toLowerCase();
    const catalog = q
      ? [
          ...srd.equipment.weapons.map((x) => ({ ...x, itemKind: 'weapon' })),
          ...srd.equipment.armor.map((x) => ({ ...x, itemKind: 'armor' })),
          ...srd.equipment.gear.map((x) => ({ ...x, itemKind: 'gear' })),
        ]
          .filter((x) => x.name.toLowerCase().includes(q))
          .slice(0, 8)
      : [];
    return String(html`
      <h2>Coins</h2>
      <div class="coins">
        ${['cp', 'sp', 'ep', 'gp', 'pp'].map((k) => html`<label>${k.toUpperCase()}<input type="number" min="0" data-coin="${k}" value="${c.coins[k] || 0}" /></label>`)}
      </div>
      <h2>Items</h2>
      <table class="inventory">
        <thead><tr><th>Item</th><th>Qty</th><th>Equipped</th><th></th></tr></thead>
        <tbody>
          ${c.inventory.map(
            (i) => html`<tr>
              <td>${i.name}${i.ref ? html` <small class="muted">${i.ref.kind}</small>` : ''}</td>
              <td><input type="number" min="0" class="small-num" data-qty="${i.uid}" value="${i.qty}" aria-label="Quantity of ${i.name}" /></td>
              <td>${i.ref && i.ref.kind !== 'gear' ? html`<input type="checkbox" data-equip="${i.uid}" ${raw(i.equipped ? 'checked' : '')} aria-label="Equip ${i.name}" />` : ''}</td>
              <td><button type="button" class="link-button small" data-remove="${i.uid}">Remove</button></td>
            </tr>`,
          )}
          ${!c.inventory.length ? html`<tr><td colspan="4" class="muted">No items.</td></tr>` : ''}
        </tbody>
      </table>
      <h3>Add an item</h3>
      <div class="add-item">
        <input id="item-search" placeholder="Search weapons, armor and gear, or type any item" value="${itemSearch}" aria-label="Item name" />
        <button type="button" class="button small" data-act="add-custom" ${raw(q ? '' : 'disabled')}>Add “${itemSearch.trim() || '…'}”</button>
      </div>
      ${catalog.length
        ? html`<ul class="catalog">${catalog.map((x) => html`<li><button type="button" data-add-kind="${x.itemKind}" data-add-id="${x.id}">${x.name} <small class="muted">${x.itemKind}${x.cost ? ` · ${x.cost}` : ''}</small></button></li>`)}</ul>`
        : ''}`);
  }

  function notesTab() {
    const field = (key, label, rows) =>
      html`<label for="note-${key}">${label}</label><textarea id="note-${key}" data-detail="${key}" rows="${rows}" maxlength="10000">${c.details[key] || ''}</textarea>`;
    return String(html`
      ${field('notes', 'Session notes', 6)}
      ${field('personality', 'Personality', 3)}
      ${field('appearance', 'Appearance', 3)}
      ${field('backstory', 'Backstory', 6)}
      <p class="muted small">Alignment: ${c.details.alignment || 'Unaligned / undecided'}</p>`);
  }

  /* ------------------------------------------------------------ events */
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = derive(c, srd);
    const amount = () => Number(root.querySelector('#hp-amount')?.value || 0);

    if (t.dataset.tab) {
      tab = t.dataset.tab;
      sessionStorage.setItem('sheetTab', tab);
      draw();
      return;
    }
    if (t.dataset.mode) {
      mode = t.dataset.mode;
      drawModeButtons();
      return;
    }
    if (t.dataset.roll) {
      const r = t.dataset.roll;
      const a = t.dataset.ability;
      if (r === 'check') doRoll(`${ABILITY_LABELS[a]} check`, d20(d.mods[a]), { d20Test: true });
      else if (r === 'save') doRoll(`${ABILITY_LABELS[a]} save`, d20(d.saves[a].bonus), { d20Test: true });
      else if (r === 'skill') doRoll(t.dataset.skill, d20(d.skills[t.dataset.skill].bonus), { d20Test: true });
      else if (r === 'initiative') doRoll('Initiative', d20(d.initiative), { d20Test: true });
      else if (r === 'spell-attack') doRoll('Spell attack', d20(d.spell.attack), { d20Test: true });
      else if (r === 'attack' || r === 'damage' || r === 'crit') {
        const atk = d.attacks.find((x) => x.uid === t.dataset.attack);
        if (!atk) return;
        if (r === 'attack') doRoll(`${atk.name} attack`, d20(atk.toHit), { d20Test: true });
        else if (r === 'damage') doRoll(`${atk.name} damage`, atk.damage);
        else doRoll(`${atk.name} critical damage`, critical(atk.damage));
      } else if (r === 'death') {
        const res = doRoll('Death save', '1d20', { d20Test: true });
        const ds = { ...c.deathSaves };
        if (res.natural === 20) {
          update(applyHealing(c, 1, d.hpMax));
          toast('Natural 20! You regain 1 Hit Point.', 'success');
          return;
        }
        if (res.natural === 1) ds.failures = Math.min(3, ds.failures + 2);
        else if (res.total >= 10) ds.successes = Math.min(3, ds.successes + 1);
        else ds.failures = Math.min(3, ds.failures + 1);
        update({ ...c, deathSaves: ds });
        if (ds.successes >= 3) toast('Three successes: you are Stable.', 'success');
        if (ds.failures >= 3) toast('Three failures: your character dies.', 'error');
      }
      return;
    }
    if (t.dataset.act === 'damage') return amount() && update(applyDamage(c, amount()));
    if (t.dataset.act === 'heal') return amount() && update(applyHealing(c, amount(), d.hpMax));
    if (t.dataset.act === 'temp') return update(applyTempHp(c, amount()));
    if (t.dataset.act === 'hit-die') {
      if ((c.hp.current ?? 0) >= d.hpMax) return toast('You are already at full Hit Points.');
      const res = doRoll(`Hit Point Die (d${d.hitDie})`, `1d${d.hitDie}${d.mods.con ? (d.mods.con > 0 ? '+' : '-') + Math.abs(d.mods.con) : ''}`);
      const healed = Math.max(1, res.total);
      update({ ...applyHealing(c, healed, d.hpMax), hitDiceSpent: (c.hitDiceSpent || 0) + 1 });
      return;
    }
    if (t.dataset.act === 'level-up') {
      if (!canLevelUp(c)) {
        const ok = await confirmDialog({ title: 'Level up without enough XP?', message: 'Do this if your DM levels the party up by milestones instead of XP.', confirmLabel: 'Level up' });
        if (!ok) return;
      }
      const next = await levelUpDialog(c, srd);
      if (next) {
        update(next);
        toast(`${c.name} is now level ${next.level}!`, 'success');
      }
      return;
    }
    if (t.dataset.act === 'inspiration') return update({ ...c, heroicInspiration: !c.heroicInspiration });
    if (t.dataset.act === 'long-rest') {
      const ok = await confirmDialog({ title: 'Take a Long Rest?', message: 'Restores all Hit Points, Hit Point Dice and spell slots, and removes one level of Exhaustion.', confirmLabel: 'Long rest' });
      if (ok) {
        update(longRest(c, d.hpMax));
        toast('Long rest finished.', 'success');
      }
      return;
    }
    if (t.dataset.act === 'short-rest') {
      update(shortRest(c));
      toast('Short rest: spend Hit Point Dice to heal if you need to.');
      return;
    }
    if (t.dataset.act === 'export') {
      downloadCharacter(c);
      toast('Character exported.');
      return;
    }
    if (t.dataset.condition) {
      const n = t.dataset.condition;
      return update({ ...c, conditions: c.conditions.includes(n) ? c.conditions.filter((x) => x !== n) : [...c.conditions, n] });
    }
    if (t.dataset.pip) {
      const key = t.dataset.pip === 'ds-success' ? 'successes' : 'failures';
      const i = Number(t.dataset.index);
      const cur = c.deathSaves[key];
      return update({ ...c, deathSaves: { ...c.deathSaves, [key]: cur === i + 1 ? i : i + 1 } });
    }
    if (t.dataset.slot) {
      const lvl = t.dataset.slot;
      const i = Number(t.dataset.index);
      const used = c.slotsUsed?.[lvl] || 0;
      return update({ ...c, slotsUsed: { ...c.slotsUsed, [lvl]: used === i + 1 ? i : i + 1 } });
    }
    if (t.dataset.remove) return update({ ...c, inventory: c.inventory.filter((i) => i.uid !== t.dataset.remove) });
    if (t.dataset.addId) {
      const list = { weapon: srd.equipment.weapons, armor: srd.equipment.armor, gear: srd.equipment.gear }[t.dataset.addKind];
      const x = list.find((i) => i.id === t.dataset.addId);
      itemSearch = '';
      update({ ...c, inventory: [...c.inventory, { uid: uid(), name: x.name, qty: 1, ref: { kind: t.dataset.addKind, id: x.id }, equipped: false }] });
      toast(`Added ${x.name}.`);
      return;
    }
    if (t.dataset.act === 'add-custom') {
      const name = itemSearch.trim().slice(0, 80);
      if (!name) return;
      itemSearch = '';
      update({ ...c, inventory: [...c.inventory, { uid: uid(), name, qty: 1, ref: null, equipped: false }] });
      return;
    }
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.field === 'exhaustion') return update({ ...c, exhaustion: Number(t.value) });
    if (t.dataset.equip) {
      const inv = c.inventory.map((i) => (i.uid === t.dataset.equip ? { ...i, equipped: t.checked } : i));
      // Only one suit of armor and one shield at a time.
      const changed = inv.find((i) => i.uid === t.dataset.equip);
      if (t.checked && changed.ref?.kind === 'armor') {
        const isShield = srd.equipment.armor.find((a) => a.id === changed.ref.id)?.isShield;
        for (const i of inv) {
          if (i.uid === changed.uid || i.ref?.kind !== 'armor' || !i.equipped) continue;
          if (!!srd.equipment.armor.find((a) => a.id === i.ref.id)?.isShield === !!isShield) i.equipped = false;
        }
      }
      return update({ ...c, inventory: inv });
    }
    if (t.dataset.qty) {
      const qty = Math.max(0, Math.floor(Number(t.value) || 0));
      return update({ ...c, inventory: c.inventory.map((i) => (i.uid === t.dataset.qty ? { ...i, qty } : i)) });
    }
    if (t.dataset.coin) {
      return update({ ...c, coins: { ...c.coins, [t.dataset.coin]: Math.max(0, Math.floor(Number(t.value) || 0)) } });
    }
  });

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.detail) {
      update({ ...c, details: { ...c.details, [t.dataset.detail]: t.value } }, { redraw: false });
      return;
    }
    if (t.id === 'item-search') {
      itemSearch = t.value;
      const pos = t.selectionStart;
      draw();
      const again = root.querySelector('#item-search');
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  });

  root.addEventListener('submit', (e) => {
    if (!e.target.classList.contains('custom-roll')) return;
    e.preventDefault();
    const input = e.target.querySelector('input');
    const expr = input.value.trim();
    if (!expr) return;
    try {
      doRoll(expr, expr);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  draw();

  // Save straight away if the page is left mid-edit.
  const flush = () => persist.flush();
  window.addEventListener('beforeunload', flush);
  return () => {
    flush();
    window.removeEventListener('beforeunload', flush);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
