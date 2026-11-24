// Step-by-step character builder (2024 / SRD 5.2.1 rules).
// Works on a plain character object (see lib/character/rules.js newCharacter)
// and saves it to the player's character library at the end.
import { html, raw, rulesMarkdown } from '../lib/dom.js';
import { loadCharacterRules, spellLevelLabel, subclassLabel } from '../lib/srd.js';
import {
  ABILITIES,
  ABILITY_LABELS,
  SKILLS,
  ALIGNMENTS,
  STANDARD_ARRAY,
  POINT_BUY_BUDGET,
  POINT_BUY_COST,
  SPECIES_CHOICES,
  newCharacter,
  derive,
  validate,
  mod,
  signed,
  pointBuySpent,
  backgroundAbilityKeys,
  spellcasting,
  parseEquipmentOptions,
  startingInventory,
  fixedSkills,
  abilityScores,
} from '../lib/character/rules.js';
import { getCharacter, createCharacter, saveCharacter, normalize } from '../lib/character/store.js';
import { roll } from '../lib/dice.js';
import { toast, confirmDialog } from '../lib/ui.js';

const md = (t) => raw(rulesMarkdown(t));
const DRAFT_KEY = 'builderDraft';

const STEPS = [
  { id: 'class', label: 'Class' },
  { id: 'background', label: 'Background' },
  { id: 'species', label: 'Species' },
  { id: 'abilities', label: 'Ability Scores' },
  { id: 'skills', label: 'Skills' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'spells', label: 'Spells', casterOnly: true },
  { id: 'details', label: 'Details & Review' },
];

export async function renderBuilder(root, { params, navigate }) {
  const editId = params[0] || null;
  root.innerHTML = '<p class="loading">Loading the rules…</p>';
  const srd = await loadCharacterRules();

  let c;
  let editingName = '';
  if (editId) {
    const row = await getCharacter(editId);
    if (!row) {
      root.innerHTML = String(html`<section class="page narrow"><h1>Character not found</h1><p><a href="#/characters">Back to your characters</a></p></section>`);
      return;
    }
    c = row.data;
    editingName = row.name;
  } else {
    try {
      c = normalize(JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null') || newCharacter());
    } catch {
      c = newCharacter();
    }
  }
  let step = 'class';
  let spellSearch = '';
  let spellAnyClass = false;
  let saving = false;

  const steps = () => STEPS.filter((s) => !s.casterOnly || spellcasting(cls(), c.level, sub()));
  const cls = () => srd.classes.find((x) => x.id === c.classId);
  const sub = () => cls()?.subclasses.find((s) => s.id === c.subclassId) || null;
  const bg = () => srd.backgrounds.find((x) => x.id === c.backgroundId);
  const species = () => srd.species.find((x) => x.id === c.speciesId);

  function persistDraft() {
    if (!editId) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(c));
  }

  /* --------------------------------------------------------------- layout */
  function draw({ keepScroll = false } = {}) {
    const y = window.scrollY;
    const list = steps();
    if (!list.some((s) => s.id === step)) step = 'details';
    const idx = list.findIndex((s) => s.id === step);
    const problems = validate(c, srd);
    const stepDone = (id) => !problems.some((p) => p.step === id);

    root.innerHTML = String(html`
      <section class="builder page">
        <div class="section-head">
          <h1 class="page-title">${editId ? `Edit ${editingName}` : 'Create a character'}</h1>
          ${editId ? html`<a class="button secondary" href="#/characters/${editId}">Back to sheet</a>` : ''}
        </div>
        <ol class="stepper" aria-label="Builder steps">
          ${list.map(
            (s, i) => html`<li>
              <button type="button" data-step="${s.id}" class="${s.id === step ? 'current' : ''} ${stepDone(s.id) ? 'done' : ''}" ${raw(s.id === step ? 'aria-current="step"' : '')}>
                <span class="num">${stepDone(s.id) && s.id !== step ? '✓' : i + 1}</span><span class="lbl">${s.label}</span>
              </button>
            </li>`,
          )}
        </ol>
        <div class="builder-body">
          <div class="builder-main card">${raw(renderStep())}</div>
          <aside class="builder-summary card">${raw(renderSummary())}</aside>
        </div>
        <div class="builder-nav">
          ${idx > 0 ? html`<button type="button" class="button secondary" data-step="${list[idx - 1].id}">← ${list[idx - 1].label}</button>` : html`<span></span>`}
          ${idx < list.length - 1
            ? html`<button type="button" class="button" data-step="${list[idx + 1].id}">${list[idx + 1].label} →</button>`
            : html`<button type="button" class="button" id="save" ${raw(problems.length || saving ? 'disabled' : '')}>${editId ? 'Save changes' : 'Save character'}</button>`}
        </div>
      </section>`);
    if (keepScroll) window.scrollTo(0, y);
  }

  function renderSummary() {
    const d = derive(c, srd);
    const parts = [d.species?.name, d.background?.name, d.cls ? `${d.cls.name} ${d.level}` : null].filter(Boolean);
    return String(html`
      <h2>${c.name || 'Unnamed hero'}</h2>
      <p class="muted">${parts.join(' · ') || 'Nothing chosen yet'}</p>
      <div class="summary-scores">
        ${ABILITIES.map((a) => html`<div><abbr title="${ABILITY_LABELS[a]}">${a.toUpperCase()}</abbr><strong>${d.scores[a]}</strong><span>${signed(d.mods[a])}</span></div>`)}
      </div>
      <dl class="facts">
        <dt>Hit Points</dt><dd>${d.hpMax}</dd>
        <dt>Armor Class</dt><dd>${c.inventory.length || !editId ? acPreview() : d.ac}</dd>
        <dt>Speed</dt><dd>${d.speed} ft.</dd>
        <dt>Proficiency</dt><dd>${signed(d.pb)}</dd>
      </dl>`);
  }

  // AC including the starting equipment the player has picked (before it's applied).
  function acPreview() {
    if (c.inventory.length) return derive(c, srd).ac;
    const preview = { ...c, ...startingInventory(c, srd) };
    return derive(preview, srd).ac;
  }

  /* ---------------------------------------------------------------- steps */
  function renderStep() {
    switch (step) {
      case 'class':
        return stepClass();
      case 'background':
        return stepBackground();
      case 'species':
        return stepSpecies();
      case 'abilities':
        return stepAbilities();
      case 'skills':
        return stepSkills();
      case 'equipment':
        return stepEquipment();
      case 'spells':
        return stepSpells();
      default:
        return stepDetails();
    }
  }

  function choiceGrid(items, selectedId, field, sub) {
    return html`<div class="choice-grid" role="radiogroup">
      ${items.map(
        (it) => html`<button type="button" role="radio" aria-checked="${it.id === selectedId}" class="choice ${it.id === selectedId ? 'selected' : ''}" data-set="${field}" data-value="${it.id}">
          <strong>${it.name}</strong><span class="muted">${sub(it)}</span>
        </button>`,
      )}
    </div>`;
  }

  function stepClass() {
    const k = cls();
    return String(html`
      <h2>Choose a class</h2>
      <p class="muted">Your class is your character's main calling: how they fight, what magic they use, and what they're good at.</p>
      ${choiceGrid(srd.classes, c.classId, 'classId', (x) => `d${x.hitDie} hit die · ${x.primaryAbility}`)}
      ${k
        ? html`
          <div class="chosen">
            <h3>${k.name}</h3>
            <div class="row">
              <label>Starting level
                <select data-set="level" data-number="1">
                  ${Array.from({ length: 20 }, (_, i) => html`<option value="${i + 1}" ${raw(c.level === i + 1 ? 'selected' : '')}>Level ${i + 1}</option>`)}
                </select>
              </label>
              ${c.level >= 3
                ? html`<label>Subclass
                    <select data-set="subclassId">
                      <option value="">Choose…</option>
                      ${k.subclasses.map((s) => html`<option value="${s.id}" ${raw(c.subclassId === s.id ? 'selected' : '')}>${subclassLabel(s)}</option>`)}
                    </select></label>`
                : html`<p class="hint">You choose a subclass at level 3.</p>`}
            </div>
            <table class="traits"><tbody>${Object.entries(k.coreTraits).map(([a, b]) => html`<tr><th scope="row">${a}</th><td>${b}</td></tr>`)}</tbody></table>
            <h4>Features up to level ${c.level}</h4>
            ${k.features.filter((f) => f.level <= c.level).map((f) => html`<details><summary>Level ${f.level}: ${f.name}</summary>${md(f.description)}</details>`)}
            ${sub() && c.level >= 3
              ? html`<h4>${sub().name} <small class="muted">${sub().sourceName}</small></h4>
                ${md(sub().description)}
                ${sub().features.filter((f) => f.level <= c.level).map((f) => html`<details><summary>Level ${f.level}: ${f.name}</summary>${md(f.description)}</details>`)}`
              : ''}
            ${c.level > 1 ? html`<p class="hint">Starting above level 1? Hit points and proficiency are worked out for you. Enter any Ability Score Improvements or feats from levels 4, 8, 12, 16 and 19 as adjustments on the Ability Scores step.</p>` : ''}
          </div>`
        : ''}`);
  }

  function stepBackground() {
    const b = bg();
    const keys = backgroundAbilityKeys(b);
    const bonus = c.backgroundBonus;
    return String(html`
      <h2>Choose a background</h2>
      <p class="muted">Your background is what your character did before adventuring. It gives ability score increases, an Origin feat, two skills, a tool and some equipment.</p>
      ${choiceGrid(srd.backgrounds, c.backgroundId, 'backgroundId', (x) => `${x.skillProficiencies.join(', ')} · ${x.feat}`)}
      ${b
        ? html`
          <div class="chosen">
            <h3>${b.name}</h3>
            <fieldset>
              <legend>Ability score increases (${keys.map((k) => ABILITY_LABELS[k]).join(', ')})</legend>
              <label class="inline"><input type="radio" name="bonus-mode" data-set="backgroundBonus.mode" value="2-1" ${raw(bonus.mode !== '1-1-1' ? 'checked' : '')} /> +2 to one and +1 to another</label>
              <label class="inline"><input type="radio" name="bonus-mode" data-set="backgroundBonus.mode" value="1-1-1" ${raw(bonus.mode === '1-1-1' ? 'checked' : '')} /> +1 to all three</label>
              ${bonus.mode !== '1-1-1'
                ? html`<div class="row">
                    <label>+2 to <select data-set="backgroundBonus.plus2"><option value="">Choose…</option>${keys.map((k) => html`<option value="${k}" ${raw(bonus.plus2 === k ? 'selected' : '')}>${ABILITY_LABELS[k]}</option>`)}</select></label>
                    <label>+1 to <select data-set="backgroundBonus.plus1"><option value="">Choose…</option>${keys.filter((k) => k !== bonus.plus2).map((k) => html`<option value="${k}" ${raw(bonus.plus1 === k ? 'selected' : '')}>${ABILITY_LABELS[k]}</option>`)}</select></label>
                  </div>`
                : ''}
            </fieldset>
            <dl class="facts">
              <dt>Origin feat</dt><dd>${b.feat}</dd>
              <dt>Skills</dt><dd>${b.skillProficiencies.join(', ')}</dd>
              <dt>Tool</dt><dd>${b.toolProficiency || '—'}</dd>
              <dt>Equipment</dt><dd>${b.equipment}</dd>
            </dl>
            ${featDetails(b.feat)}
          </div>`
        : ''}`);
  }

  function featDetails(label) {
    const f = srd.feats.find((x) => x.name === String(label || '').replace(/\s*\(.*\)$/, ''));
    return f ? html`<details><summary>Feat: ${label}</summary>${md(f.description)}</details>` : '';
  }

  function stepSpecies() {
    const s = species();
    const choices = SPECIES_CHOICES[c.speciesId] || [];
    const originFeats = srd.feats.filter((f) => f.category === 'Origin Feat');
    return String(html`
      <h2>Choose a species</h2>
      <p class="muted">Your species gives your size, speed and special traits.</p>
      ${choiceGrid(srd.species, c.speciesId, 'speciesId', (x) => `Speed ${x.speed} ft. · ${x.traits.map((t) => t.name).slice(0, 3).join(', ')}`)}
      ${s
        ? html`
          <div class="chosen">
            <h3>${s.name}</h3>
            ${choices.length
              ? html`<div class="row wrap">${choices.map((ch) => {
                  const opts = ch.options === 'origin-feats' ? originFeats.map((f) => [f.name, f.name]) : ch.options;
                  return html`<label>${ch.label}<select data-set="speciesOptions.${ch.key}"><option value="">Choose…</option>${opts.map(([v, l]) => html`<option value="${v}" ${raw(c.speciesOptions[ch.key] === v ? 'selected' : '')}>${l}</option>`)}</select></label>`;
                })}</div>`
              : ''}
            ${md(s.description)}
            ${c.speciesId === 'human' && c.speciesOptions.feat ? featDetails(c.speciesOptions.feat) : ''}
          </div>`
        : ''}`);
  }

  function stepAbilities() {
    const method = c.abilityMethod;
    const b = c.backgroundBonus;
    const final = abilityScores(c);
    const bonusFor = (a) =>
      b.mode === '1-1-1' ? ((b.plus1s || []).includes(a) ? 1 : 0) : (b.plus2 === a ? 2 : 0) + (b.plus1 === a ? 1 : 0);
    const pool = method === 'roll' ? c.rolledScores || [] : STANDARD_ARRAY;

    // For array-style methods each value can only be assigned once (by index, so duplicates work).
    function poolSelect(a) {
      const takenIdx = [];
      for (const other of ABILITIES) {
        if (other === a) continue;
        const v = c.baseScores[other];
        const i = pool.findIndex((p, idx) => p === v && !takenIdx.includes(idx));
        if (i !== -1) takenIdx.push(i);
      }
      return html`<select data-set="baseScores.${a}" data-number="1" aria-label="${ABILITY_LABELS[a]} score">
        <option value="">—</option>
        ${pool.map((v, i) => (takenIdx.includes(i) && c.baseScores[a] !== v ? '' : html`<option value="${v}" ${raw(c.baseScores[a] === v ? 'selected' : '')}>${v}</option>`))}
      </select>`;
    }

    const spent = pointBuySpent(Object.fromEntries(ABILITIES.map((a) => [a, c.baseScores[a] ?? 8])));
    return String(html`
      <h2>Ability scores</h2>
      <p class="muted">Pick how to generate your six scores, then assign them. Your background's increases are added automatically (max 20).</p>
      <div class="segmented" role="radiogroup" aria-label="Method">
        ${[
          ['standard', 'Standard array'],
          ['pointbuy', 'Point buy'],
          ['roll', 'Roll 4d6'],
          ['manual', 'Enter manually'],
        ].map(([v, l]) => html`<button type="button" role="radio" aria-checked="${method === v}" class="${method === v ? 'selected' : ''}" data-method="${v}">${l}</button>`)}
      </div>
      ${method === 'standard' ? html`<p class="hint">Assign 15, 14, 13, 12, 10 and 8, one to each ability.</p>` : ''}
      ${method === 'pointbuy' ? html`<p class="hint">Every score starts at 8. You have ${POINT_BUY_BUDGET} points; scores cost more as they go up (max 15). <strong class="${spent > POINT_BUY_BUDGET ? 'error' : ''}">Spent ${spent} / ${POINT_BUY_BUDGET}</strong></p>` : ''}
      ${method === 'roll'
        ? html`<p class="hint">Roll four d6 six times and keep the highest three of each. Then assign the totals.</p>
          <button type="button" class="button secondary" id="roll-scores">${c.rolledScores ? 'Roll again' : 'Roll the dice'}</button>
          ${c.rolledScores ? html`<p class="rolled">Your rolls: ${c.rolledScores.join(', ')}</p>` : ''}`
        : ''}
      <table class="score-table">
        <thead><tr><th>Ability</th><th>Base</th><th>Background</th><th>Adjust</th><th>Score</th><th>Modifier</th></tr></thead>
        <tbody>
          ${ABILITIES.map(
            (a) => html`<tr>
              <th scope="row">${ABILITY_LABELS[a]}</th>
              <td>${method === 'manual'
                ? html`<input type="number" min="3" max="20" data-set="baseScores.${a}" data-number="1" value="${c.baseScores[a] ?? ''}" aria-label="${ABILITY_LABELS[a]} base score" />`
                : method === 'pointbuy'
                  ? html`<div class="stepper-input">
                      <button type="button" data-pb="${a}" data-delta="-1" aria-label="Lower ${ABILITY_LABELS[a]}" ${raw((c.baseScores[a] ?? 8) <= 8 ? 'disabled' : '')}>−</button>
                      <span>${c.baseScores[a] ?? 8}</span>
                      <button type="button" data-pb="${a}" data-delta="1" aria-label="Raise ${ABILITY_LABELS[a]}" ${raw((c.baseScores[a] ?? 8) >= 15 || spent + (POINT_BUY_COST[(c.baseScores[a] ?? 8) + 1] - POINT_BUY_COST[c.baseScores[a] ?? 8]) > POINT_BUY_BUDGET ? 'disabled' : '')}>+</button>
                    </div>`
                  : pool.length
                    ? poolSelect(a)
                    : html`<span class="muted">Roll first</span>`}</td>
              <td>${bonusFor(a) ? `+${bonusFor(a)}` : '—'}</td>
              <td><input type="number" min="-10" max="10" class="small-num" data-set="scoreAdjust.${a}" data-number="1" value="${c.scoreAdjust[a] || 0}" aria-label="${ABILITY_LABELS[a]} adjustment" /></td>
              <td><strong>${c.baseScores[a] == null ? '—' : final[a]}</strong></td>
              <td>${c.baseScores[a] == null ? '' : signed(mod(final[a]))}</td>
            </tr>`,
          )}
        </tbody>
      </table>
      <p class="hint">Use <em>Adjust</em> for Ability Score Improvements from higher levels or anything your DM allows.</p>`);
  }

  function stepSkills() {
    const k = cls();
    if (!k) return String(html`<h2>Skills</h2><p>Choose a class first.</p>`);
    const fixed = fixedSkills(c, srd);
    const opts = k.skillChoices?.options === 'any' ? Object.keys(SKILLS) : k.skillChoices?.options || [];
    const count = k.skillChoices?.count || 0;
    const chosen = c.classSkills;
    const expertiseCount = k.features.filter((f) => f.level <= c.level && f.name === 'Expertise').length * 2;
    const proficient = [...new Set([...fixed, ...chosen])];
    return String(html`
      <h2>Skills</h2>
      <p class="muted">Your ${k.name} chooses ${count} skill${count === 1 ? '' : 's'}. Skills you already have from your background or species are marked.</p>
      <p class="hint"><strong>${chosen.length} / ${count}</strong> chosen</p>
      <div class="check-grid">
        ${Object.keys(SKILLS).map((s) => {
          const has = fixed.has(s);
          const offered = opts.includes(s);
          const checked = chosen.includes(s);
          return html`<label class="check ${has ? 'fixed' : ''} ${!offered && !has ? 'unavailable' : ''}">
            <input type="checkbox" data-skill="${s}" ${raw(checked || has ? 'checked' : '')} ${raw(has || !offered || (!checked && chosen.length >= count) ? 'disabled' : '')} />
            <span>${s} <small class="muted">(${ABILITY_LABELS[SKILLS[s]].slice(0, 3)})</small>${has ? html` <small class="tag">from ${fixedSource(s)}</small>` : ''}</span>
          </label>`;
        })}
      </div>
      ${expertiseCount
        ? html`<h3>Expertise</h3>
          <p class="hint">Choose ${expertiseCount} skills you're proficient in. You add double your proficiency bonus to them. <strong>${(c.expertise || []).length} / ${expertiseCount}</strong></p>
          <div class="check-grid">${proficient.map((s) => {
            const on = (c.expertise || []).includes(s);
            return html`<label class="check"><input type="checkbox" data-expertise="${s}" ${raw(on ? 'checked' : '')} ${raw(!on && (c.expertise || []).length >= expertiseCount ? 'disabled' : '')} /> <span>${s}</span></label>`;
          })}</div>`
        : ''}`);
  }

  function fixedSource(skill) {
    if (bg()?.skillProficiencies.includes(skill)) return 'background';
    return 'species';
  }

  function stepEquipment() {
    const k = cls();
    const b = bg();
    const describe = (opt) =>
      [
        ...opt.items.map((i) => (i.qty > 1 ? `${i.qty} × ${i.name}` : i.name)),
        ...Object.entries(opt.coins)
          .filter(([, n]) => n)
          .map(([coin, n]) => `${n} ${coin.toUpperCase()}`),
      ].join(', ');
    const block = (title, text, field) => {
      const options = parseEquipmentOptions(text);
      const current = c.equipmentChoice[field] || 'A';
      return html`<fieldset>
        <legend>${title}</legend>
        ${Object.entries(options).map(
          ([letter, opt]) => html`<label class="option"><input type="radio" name="eq-${field}" data-set="equipmentChoice.${field}" value="${letter}" ${raw(current === letter ? 'checked' : '')} />
            <span><strong>Option ${letter}:</strong> ${describe(opt) || 'Nothing'}</span></label>`,
        )}
      </fieldset>`;
    };
    return String(html`
      <h2>Starting equipment</h2>
      ${!k || !b
        ? html`<p>Choose a class and background first.</p>`
        : html`
          <p class="muted">Take the equipment package, or the gold to buy your own gear later.</p>
          ${block(`${k.name} equipment`, k.startingEquipment, 'class')}
          ${block(`${b.name} equipment`, b.equipment, 'background')}
          ${editId || c.inventory.length
            ? html`<div class="callout">
                <p>This character already has ${c.inventory.length} item${c.inventory.length === 1 ? '' : 's'} in their inventory. Their inventory is kept unless you replace it.</p>
                <button type="button" class="button secondary" id="apply-equipment">Replace inventory with this starting equipment</button>
              </div>`
            : html`<p class="hint">Armor, shields and weapons are equipped for you. You can change that on the character sheet.</p>`}`}`);
  }

  function stepSpells() {
    const k = cls();
    const casting = spellcasting(k, c.level, sub());
    if (!casting) return String(html`<h2>Spells</h2><p>Your class doesn't cast spells.</p>`);
    const q = spellSearch.toLowerCase();
    // The class list (or the subclass's, e.g. an Eldritch Trickster uses the
    // Wizard's), any extra lists the subclass adds, and optionally the spells
    // from other books that don't say which classes get them.
    const lists = [casting.list, ...(sub()?.extraSpellLists || [])];
    const always = derive(c, srd).alwaysSpells;
    const classSpells = srd.spells.filter(
      (s) => !always.includes(s) && (s.classes.some((x) => lists.includes(x)) || (spellAnyClass && !s.classes.length)),
    );
    const cantrips = classSpells.filter((s) => s.level === 0);
    const leveled = classSpells.filter((s) => s.level > 0 && s.level <= casting.maxSpellLevel);
    const match = (s) => !q || [s.name, s.school, s.sourceName || ''].some((x) => x.toLowerCase().includes(q));
    const list = (spells, kind, max) => {
      const chosen = c.spells[kind];
      return html`<div class="spell-pick">${spells.filter(match).map((s) => {
        const on = chosen.includes(s.id);
        return html`<div class="spell-row ${on ? 'on' : ''}">
          <label><input type="checkbox" data-spell="${s.id}" data-kind="${kind}" ${raw(on ? 'checked' : '')} ${raw(!on && chosen.length >= max ? 'disabled' : '')} />
          <span><strong>${s.name}</strong> <small class="muted">${spellLevelLabel(s.level)} ${s.school}${s.concentration ? ' · C' : ''}${s.ritual ? ' · R' : ''}${s.source && s.source !== 'srd' ? ` · ${s.sourceName}` : ''}</small></span></label>
          <details><summary>Details</summary><p class="muted">${s.castingTime} · ${s.range} · ${s.duration}</p>${md(s.description)}</details>
        </div>`;
      })}</div>`;
    };
    return String(html`
      <h2>Spells</h2>
      <p class="muted">${k.name}s cast spells with ${ABILITY_LABELS[casting.ability]}. At level ${c.level} you know ${casting.cantrips} cantrip${casting.cantrips === 1 ? '' : 's'} and prepare ${casting.prepared} spell${casting.prepared === 1 ? '' : 's'} of up to ${spellLevelLabel(casting.maxSpellLevel).toLowerCase()}. You can change prepared spells later on the sheet.</p>
      ${casting.fromSubclass ? html`<p class="hint">Your ${casting.fromSubclass} spells come from the ${casting.list} spell list.</p>` : ''}
      ${always.length
        ? html`<h3>Always prepared <small class="muted">from your subclass; they don't count against your limit</small></h3>
            <p>${always.map((s, i) => html`${i ? ', ' : ''}<strong>${s.name}</strong>`)}</p>`
        : ''}
      <input type="search" id="spell-search" placeholder="Search spells or books…" value="${spellSearch}" aria-label="Search spells" />
      <label class="check"><input type="checkbox" id="spell-any" ${raw(spellAnyClass ? 'checked' : '')}> Also show spells from other books that don't list a class (ask your DM)</label>
      ${casting.cantrips
        ? html`<h3>Cantrips <small class="muted">${c.spells.cantrips.length} / ${casting.cantrips}</small></h3>${list(cantrips, 'cantrips', casting.cantrips)}`
        : ''}
      <h3>Prepared spells <small class="muted">${c.spells.prepared.length} / ${casting.prepared}</small></h3>
      ${list(leveled, 'prepared', casting.prepared)}`);
  }

  function stepDetails() {
    const problems = validate(c, srd);
    const d = derive(c, srd);
    return String(html`
      <h2>Details</h2>
      <label for="char-name">Name</label>
      <input id="char-name" data-set="name" maxlength="80" value="${c.name}" placeholder="e.g. Tamsin Ironwood" />
      <label for="char-align">Alignment</label>
      <select id="char-align" data-set="details.alignment"><option value="">Unaligned / undecided</option>${ALIGNMENTS.map((a) => html`<option ${raw(c.details.alignment === a ? 'selected' : '')}>${a}</option>`)}</select>
      <label for="char-look">Appearance</label>
      <textarea id="char-look" data-set="details.appearance" rows="2" maxlength="2000">${c.details.appearance}</textarea>
      <label for="char-pers">Personality</label>
      <textarea id="char-pers" data-set="details.personality" rows="2" maxlength="2000">${c.details.personality}</textarea>
      <label for="char-back">Backstory</label>
      <textarea id="char-back" data-set="details.backstory" rows="4" maxlength="10000">${c.details.backstory}</textarea>

      <h2>Review</h2>
      ${problems.length
        ? html`<div class="callout error"><p>Before you can save:</p><ul>${problems.map((p) => html`<li><button type="button" class="link-button" data-step="${p.step}">${p.message}</button></li>`)}</ul></div>`
        : html`<p class="message success">Everything's ready. Save your character to open their sheet.</p>`}
      <dl class="facts">
        <dt>Class</dt><dd>${d.cls ? `${d.cls.name} ${d.level}${d.subclass ? ` (${d.subclass.name})` : ''}` : '—'}</dd>
        <dt>Species</dt><dd>${d.species?.name || '—'}${c.speciesOptions.lineage ? ` (${c.speciesOptions.lineage})` : ''}</dd>
        <dt>Background</dt><dd>${d.background?.name || '—'}</dd>
        <dt>Feats</dt><dd>${d.feats.map((f) => f.name).join(', ') || '—'}</dd>
        <dt>Skills</dt><dd>${Object.entries(d.skills).filter(([, s]) => s.proficient).map(([n, s]) => `${n} ${signed(s.bonus)}`).join(', ') || '—'}</dd>
        <dt>Saving throws</dt><dd>${ABILITIES.filter((a) => d.saves[a].proficient).map((a) => `${ABILITY_LABELS[a]} ${signed(d.saves[a].bonus)}`).join(', ') || '—'}</dd>
        ${d.spell ? html`<dt>Spellcasting</dt><dd>Save DC ${d.spell.saveDc}, attack ${signed(d.spell.attack)}</dd>` : ''}
      </dl>`);
  }

  /* --------------------------------------------------------------- events */
  function setPath(path, value) {
    const keys = path.split('.');
    let o = c;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    o[keys.at(-1)] = value;
  }

  function afterChange(path) {
    // Keep dependent choices consistent.
    if (path === 'classId') {
      c.subclassId = null;
      c.classSkills = [];
      c.expertise = [];
      c.spells = { cantrips: [], prepared: [] };
      c.equipmentChoice.class = 'A';
    }
    if (path === 'level') {
      const k = cls();
      if (c.level < 3) c.subclassId = null;
      const casting = spellcasting(k, c.level, sub());
      if (casting) {
        c.spells.cantrips = c.spells.cantrips.slice(0, casting.cantrips);
        c.spells.prepared = c.spells.prepared.slice(0, casting.prepared);
      }
    }
    if (path === 'backgroundId') {
      c.backgroundBonus = { mode: c.backgroundBonus.mode || '2-1', plus2: null, plus1: null };
      if (c.backgroundBonus.mode === '1-1-1') c.backgroundBonus.plus1s = backgroundAbilityKeys(bg());
      c.equipmentChoice.background = 'A';
      dropDuplicateSkills();
    }
    if (path === 'backgroundBonus.mode') {
      if (c.backgroundBonus.mode === '1-1-1') c.backgroundBonus.plus1s = backgroundAbilityKeys(bg());
      else c.backgroundBonus.plus1s = [];
    }
    if (path === 'backgroundBonus.plus2' && c.backgroundBonus.plus1 === c.backgroundBonus.plus2) c.backgroundBonus.plus1 = null;
    if (path === 'speciesId') c.speciesOptions = {};
    if (path.startsWith('speciesOptions') || path === 'speciesId') dropDuplicateSkills();
    persistDraft();
  }

  function dropDuplicateSkills() {
    const fixed = fixedSkills(c, srd);
    c.classSkills = c.classSkills.filter((s) => !fixed.has(s));
  }

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-set][data-value]');
    if (!t) return;
    if (t.dataset.step) {
      step = t.dataset.step;
      draw();
      root.querySelector('.builder-main')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (t.dataset.value && t.dataset.set) {
      if (t.dataset.set === 'classId' && c.classId && c.classId !== t.dataset.value && (c.classSkills.length || c.spells.prepared.length)) {
        const ok = await confirmDialog({ title: 'Change class?', message: 'Your class skills and spells will be cleared.', confirmLabel: 'Change class' });
        if (!ok) return;
      }
      setPath(t.dataset.set, t.dataset.value);
      afterChange(t.dataset.set);
      draw({ keepScroll: true });
      return;
    }
    if (t.dataset.method) {
      if (c.abilityMethod !== t.dataset.method) {
        c.abilityMethod = t.dataset.method;
        c.baseScores = Object.fromEntries(ABILITIES.map((a) => [a, c.abilityMethod === 'pointbuy' ? 8 : null]));
        persistDraft();
        draw({ keepScroll: true });
      }
      return;
    }
    if (t.dataset.pb) {
      const a = t.dataset.pb;
      const next = (c.baseScores[a] ?? 8) + Number(t.dataset.delta);
      if (next >= 8 && next <= 15) {
        c.baseScores[a] = next;
        persistDraft();
        draw({ keepScroll: true });
      }
      return;
    }
    if (t.id === 'roll-scores') {
      if (c.rolledScores && !(await confirmDialog({ title: 'Roll again?', message: 'Your current rolls will be replaced.', confirmLabel: 'Roll again' }))) return;
      c.rolledScores = Array.from({ length: 6 }, () => roll('4d6kh3').total).sort((x, y) => y - x);
      c.baseScores = Object.fromEntries(ABILITIES.map((a) => [a, null]));
      persistDraft();
      draw({ keepScroll: true });
      return;
    }
    if (t.id === 'apply-equipment') {
      const ok = await confirmDialog({ title: 'Replace inventory?', message: 'Their current items and coins will be replaced with this starting equipment.', confirmLabel: 'Replace' });
      if (!ok) return;
      Object.assign(c, startingInventory(c, srd));
      toast('Inventory replaced.', 'success');
      draw({ keepScroll: true });
      return;
    }
    if (t.id === 'save') await save();
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.skill) {
      const s = t.dataset.skill;
      c.classSkills = t.checked ? [...new Set([...c.classSkills, s])] : c.classSkills.filter((x) => x !== s);
      c.expertise = (c.expertise || []).filter((x) => c.classSkills.includes(x) || fixedSkills(c, srd).has(x));
      persistDraft();
      draw({ keepScroll: true });
      return;
    }
    if (t.dataset.expertise) {
      const s = t.dataset.expertise;
      const cur = c.expertise || [];
      c.expertise = t.checked ? [...new Set([...cur, s])] : cur.filter((x) => x !== s);
      persistDraft();
      draw({ keepScroll: true });
      return;
    }
    if (t.id === 'spell-any') {
      spellAnyClass = t.checked;
      draw({ keepScroll: true });
      return;
    }
    if (t.dataset.spell) {
      const kind = t.dataset.kind;
      const cur = c.spells[kind];
      c.spells[kind] = t.checked ? [...new Set([...cur, t.dataset.spell])] : cur.filter((x) => x !== t.dataset.spell);
      persistDraft();
      draw({ keepScroll: true });
      return;
    }
    if (t.dataset.set && t.tagName !== 'TEXTAREA' && !(t.tagName === 'INPUT' && t.type === 'text') && t.id !== 'char-name') {
      let v = t.value;
      if (t.dataset.number) v = v === '' ? null : Number(v);
      if (v === '') v = null;
      setPath(t.dataset.set, v);
      afterChange(t.dataset.set);
      draw({ keepScroll: true });
    }
  });

  // Text fields update without redrawing (so typing isn't interrupted).
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'spell-search') {
      spellSearch = t.value;
      const pos = t.selectionStart;
      draw({ keepScroll: true });
      const again = root.querySelector('#spell-search');
      again.focus();
      again.setSelectionRange(pos, pos);
      return;
    }
    if (t.dataset.set && (t.tagName === 'TEXTAREA' || t.id === 'char-name')) {
      setPath(t.dataset.set, t.value);
      persistDraft();
      if (t.id === 'char-name') {
        root.querySelector('.builder-summary h2').textContent = t.value || 'Unnamed hero';
        const saveBtn = root.querySelector('#save');
        if (saveBtn) saveBtn.disabled = validate(c, srd).length > 0 || saving;
      }
    }
  });
  // Refresh the review list once the name field loses focus.
  root.addEventListener('focusout', (e) => {
    if (e.target.id === 'char-name' && step === 'details') draw({ keepScroll: true });
  });

  async function save() {
    if (saving) return;
    const problems = validate(c, srd);
    if (problems.length) return toast(problems[0].message, 'error');
    saving = true;
    const btn = root.querySelector('#save');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving…';
    }
    try {
      if (!c.inventory.length && !editId) Object.assign(c, startingInventory(c, srd));
      const d = derive(c, srd);
      if (c.hp.current == null || c.hp.current > d.hpMax) c.hp.current = d.hpMax;
      c.name = c.name.trim();
      let id = editId;
      if (editId) await saveCharacter(editId, c);
      else id = (await createCharacter(c)).id;
      sessionStorage.removeItem(DRAFT_KEY);
      toast(`${c.name} saved.`, 'success');
      navigate(`/characters/${id}`);
    } catch (err) {
      saving = false;
      toast(err.message, 'error');
      draw({ keepScroll: true });
    }
  }

  draw();
}
