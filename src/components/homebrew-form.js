// The homebrew editor's forms. Each input names the field it edits with
// data-path ("abilities.str.score", "actions.0.damage"); the page keeps one
// form object, writes inputs into it and re-draws when the shape changes
// (a list item added, or a choice that shows other fields).
import { html, raw } from '../lib/dom.js';
import { SKILLS } from '../lib/character/rules.js';
import {
  ABILITY_KEYS, ABILITY_NAMES, DAMAGE_TYPES, CONDITIONS, SIZES, CREATURE_TYPES, SCHOOLS, CR_LIST,
  WEAPON_PROPERTIES, MASTERIES, RARITIES, ITEM_CATEGORIES, FEAT_CATEGORIES, CASTER_TYPES,
} from '../lib/homebrew/kinds.js';

/* ------------------------------------------------------------ paths */

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys.at(-1)] = value;
}

/** Read an input's value the way its field stores it. */
export function readInput(el, form) {
  const type = el.dataset.type || 'text';
  if (type === 'bool') return el.checked;
  if (type === 'number') return el.value === '' ? '' : Number(el.value);
  if (type === 'csv') return el.value.split(',').map((x) => x.trim()).filter(Boolean);
  if (type === 'multi') {
    const list = new Set(getPath(form, el.dataset.path) || []);
    if (el.checked) list.add(el.value);
    else list.delete(el.value);
    // Keep the order of the choices, not the order they were ticked.
    const order = [...el.closest('[data-multi]').querySelectorAll('input')].map((i) => i.value);
    return order.filter((v) => list.has(v));
  }
  return el.value;
}

/* ------------------------------------------------------------ fields */

const ABILITY_OPTIONS = ABILITY_KEYS.map((k) => [k, ABILITY_NAMES[k]]);
const opts = (list) => list.map((x) => (Array.isArray(x) ? x : [x, x]));

function makeFields(form) {
  const v = (path) => getPath(form, path);
  const attrs = (path, type, rerender) => raw(`data-path="${path}" data-type="${type}"${rerender ? ' data-rerender' : ''}`);
  const hint = (h) => (h ? html`<span class="hint">${h}</span>` : '');
  const f = {
    v,
    text: (label, path, { hint: h, placeholder = '', list = '', max = 200 } = {}) =>
      html`<label>${label}${hint(h)}<input type="text" ${attrs(path, 'text')} value="${v(path) ?? ''}" placeholder="${placeholder}" maxlength="${max}" ${raw(list ? `list="${list}"` : '')} /></label>`,
    num: (label, path, { min = '', max = '', step = 1, hint: h } = {}) =>
      html`<label>${label}${hint(h)}<input type="number" ${attrs(path, 'number')} value="${v(path) ?? ''}" min="${min}" max="${max}" step="${step}" /></label>`,
    area: (label, path, { hint: h, rows = 4, placeholder = '' } = {}) =>
      html`<label class="wide">${label}${hint(h)}<textarea ${attrs(path, 'text')} rows="${rows}" maxlength="20000" placeholder="${placeholder}">${v(path) ?? ''}</textarea></label>`,
    sel: (label, path, options, { rerender = false, hint: h, blank = null } = {}) => {
      // With no blank choice the browser shows the first option, so store it too.
      const list = opts(options);
      if (blank == null && list.length && !list.some(([val]) => String(val) === String(v(path) ?? ''))) setPath(form, path, list[0][0]);
      return html`<label>${label}${hint(h)}<select ${attrs(path, 'text', rerender)}>
        ${blank != null ? html`<option value="">${blank}</option>` : ''}
        ${list.map(([val, l]) => html`<option value="${val}" ${raw(String(v(path) ?? '') === String(val) ? 'selected' : '')}>${l}</option>`)}
      </select></label>`;
    },
    check: (label, path, { rerender = false } = {}) =>
      html`<label class="inline"><input type="checkbox" ${attrs(path, 'bool', rerender)} ${raw(v(path) ? 'checked' : '')} /> ${label}</label>`,
    multi: (label, path, options, { hint: h, max = 0 } = {}) => {
      const chosen = v(path) || [];
      return html`<fieldset class="wide" data-multi ${raw(max ? `data-max="${max}"` : '')}><legend>${label}</legend>${hint(h)}<div class="check-grid">
        ${opts(options).map(([val, l]) => html`<label class="check"><input type="checkbox" ${attrs(path, 'multi')} value="${val}" ${raw(chosen.includes(val) ? 'checked' : '')} /> ${l}</label>`)}
      </div></fieldset>`;
    },
    csv: (label, path, { hint: h, placeholder = '' } = {}) =>
      html`<label class="wide">${label}${hint(h)}<input type="text" ${attrs(path, 'csv')} value="${(v(path) || []).join(', ')}" placeholder="${placeholder}" maxlength="2000" /></label>`,
    /** A repeatable group: traits, actions, features... */
    list: (title, path, item, { add = 'Add', template = path, hint: h } = {}) => {
      const items = v(path) || [];
      return html`<section class="hb-list wide"><h3>${title}</h3>${hint(h)}
        ${items.map(
          (it, i) => html`<fieldset class="hb-item">
            <div class="hb-item-head"><span class="muted small">${i + 1}.</span>
              ${i > 0 ? html`<button type="button" class="link-button small" data-move="${path}.${i}" data-dir="-1" title="Move up">↑</button>` : ''}
              ${i < items.length - 1 ? html`<button type="button" class="link-button small" data-move="${path}.${i}" data-dir="1" title="Move down">↓</button>` : ''}
              <button type="button" class="link-button small danger-text" data-remove="${path}.${i}">Remove</button></div>
            <div class="hb-grid">${item(`${path}.${i}`, it, i)}</div>
          </fieldset>`,
        )}
        <button type="button" class="button small secondary" data-add="${path}" data-template="${template}">${add}</button>
      </section>`;
    },
    row: (...parts) => html`<div class="hb-grid">${parts}</div>`,
    section: (title, ...parts) => html`<section class="hb-section"><h2>${title}</h2><div class="hb-grid">${parts}</div></section>`,
  };
  return f;
}

/** New items for each list (data-template). */
export const TEMPLATES = {
  traits: () => ({ name: '', text: '' }),
  action: () => ({ name: '', mode: 'attack', attackKind: 'melee', bonus: 4, reach: 5, damage: '1d6+2', damageType: 'Slashing' }),
  classFeature: () => ({ level: 1, name: '', description: '' }),
  subclassFeature: () => ({ level: 3, name: '', description: '' }),
  alwaysPrepared: () => ({ level: 3, spells: [] }),
};

/* -------------------------------------------------------- the forms */

function actionFields(f, p, a, { who }) {
  const mode = a.mode || 'text';
  // Sensible starting values when an action switches to a save.
  if (mode === 'save') {
    a.saveAbility ||= 'dex';
    if (a.dc === undefined || a.dc === '') a.dc = 13;
  }
  return html`
    ${f.text('Name', `${p}.name`, { placeholder: 'Bite' })}
    ${f.sel('What it does', `${p}.mode`, [['attack', 'Attack roll'], ['save', 'Saving throw'], ['text', 'Something else (text only)']], { rerender: true })}
    ${f.num('Uses per day', `${p}.usesPerDay`, { min: 0, max: 9, hint: 'Blank = unlimited' })}
    ${f.text('Recharge', `${p}.recharge`, { placeholder: '5–6', max: 10 })}
    ${mode === 'attack'
      ? html`${f.sel('Attack', `${p}.attackKind`, [['melee', 'Melee'], ['ranged', 'Ranged']], { rerender: true })}
        ${f.num('To hit', `${p}.bonus`, { min: -5, max: 30, hint: 'e.g. 5 for +5' })}
        ${a.attackKind === 'ranged' ? f.text('Range (feet)', `${p}.range`, { placeholder: '80/320', max: 20 }) : f.num('Reach (feet)', `${p}.reach`, { min: 5, max: 60, step: 5 })}
        ${f.text('Damage dice', `${p}.damage`, { placeholder: '2d6+3', max: 30 })}
        ${f.sel('Damage type', `${p}.damageType`, DAMAGE_TYPES)}
        ${f.text('Extra damage dice', `${p}.extraDamage`, { placeholder: '1d6 (optional)', max: 30 })}
        ${f.sel('Extra damage type', `${p}.extraType`, DAMAGE_TYPES, { blank: '—' })}`
      : ''}
    ${mode === 'save'
      ? html`${f.sel('Saving throw', `${p}.saveAbility`, ABILITY_OPTIONS)}
        ${f.num('DC', `${p}.dc`, { min: 1, max: 30 })}
        ${f.text('Damage dice', `${p}.damage`, { placeholder: '6d6 (optional)', max: 30 })}
        ${f.sel('Damage type', `${p}.damageType`, DAMAGE_TYPES)}
        ${f.check('Half damage on a success', `${p}.half`)}
        ${f.sel('Condition on a failure', `${p}.condition`, CONDITIONS, { blank: 'None' })}
        ${f.text('Who it affects', `${p}.targets`, { placeholder: `each creature in a 30-foot Cone`, hint: `Written after the DC, e.g. "one creature ${who} can see within 60 feet"` })}`
      : ''}
    ${f.area(mode === 'text' ? 'Description' : 'Description (optional)', `${p}.text`, {
      rows: 3,
      hint: mode === 'text' ? '' : 'Leave blank and the site writes it from the numbers above.',
    })}`;
}

function featureFields(f, p, { minLevel = 1 } = {}) {
  return html`${f.num('Level', `${p}.level`, { min: minLevel, max: 20 })}${f.text('Feature name', `${p}.name`)}${f.area('What it does', `${p}.description`, { rows: 4 })}`;
}

const FORMS = {
  monster(f, form) {
    const who = `the ${String(form.name || 'creature').toLowerCase()}`;
    const actionList = (title, path, add) => f.list(title, path, (p, a) => actionFields(f, p, a, { who }), { add, template: 'action' });
    return html`
      ${f.section(
        'Basics',
        f.text('Name', 'name', { placeholder: 'Mud Troll' }),
        f.sel('Size', 'size', SIZES),
        f.text('Type', 'type', { list: 'hb-creature-types' }),
        f.text('Alignment', 'alignment'),
        f.num('Armor Class', 'acValue', { min: 1, max: 40 }),
        f.text('Armor note', 'acNote', { placeholder: 'natural armor' }),
        f.num('Hit points', 'hp.average', { min: 1, max: 9999 }),
        f.text('Hit dice', 'hp.formula', { placeholder: '8d10+24' }),
        f.text('Speed', 'speed', { placeholder: '30 ft., Climb 20 ft.' }),
        f.sel('Challenge rating', 'cr.rating', CR_LIST),
      )}
      <datalist id="hb-creature-types">${CREATURE_TYPES.map((t) => html`<option value="${t}"></option>`)}</datalist>
      ${f.section(
        'Ability scores',
        ABILITY_KEYS.map((k) => f.num(ABILITY_NAMES[k], `abilities.${k}.score`, { min: 1, max: 30 })),
        f.multi('Saving throw proficiencies', 'saveProfs', ABILITY_OPTIONS, { hint: 'Proficiency bonus comes from the CR.' }),
      )}
      ${f.section(
        'Details',
        f.text('Skills', 'skills', { placeholder: 'Perception +5, Stealth +4' }),
        f.text('Vulnerabilities', 'vulnerabilities'),
        f.text('Resistances', 'resistances'),
        f.text('Immunities', 'immunities', { placeholder: 'Poison; Poisoned' }),
        f.text('Senses', 'senses', { placeholder: 'Darkvision 60 ft.; Passive Perception 13' }),
        f.text('Languages', 'languages'),
      )}
      ${f.list('Traits', 'traits', (p) => html`${f.text('Name', `${p}.name`)}${f.area('Text', `${p}.text`, { rows: 3 })}`, { add: 'Add a trait', template: 'traits' })}
      ${actionList('Actions', 'actions', 'Add an action')}
      ${actionList('Bonus actions', 'bonusActions', 'Add a bonus action')}
      ${actionList('Reactions', 'reactions', 'Add a reaction')}
      ${actionList('Legendary actions', 'legendaryActions', 'Add a legendary action')}
      ${(form.legendaryActions || []).length ? f.area('Legendary actions intro (optional)', 'legendaryActionsIntro', { rows: 2, hint: 'Blank: 3 uses, the standard wording.' }) : ''}
      ${f.section('Mythic trait (optional)', f.text('Name', 'mythicTrait.name', { placeholder: 'Unbroken (Recharges after a Long Rest)' }), f.area('Text', 'mythicTrait.text', { rows: 3 }))}
      ${f.list('Mythic actions', 'mythicActions', (p, a) => actionFields(f, p, a, { who }), { add: 'Add a mythic action', template: 'action', hint: 'Only used if the mythic trait above is filled in.' })}`;
  },

  spell(f, form, ctx) {
    const m = form.mechanics || {};
    const kind = m.kind || 'other';
    return html`
      ${f.section(
        'Basics',
        f.text('Name', 'name'),
        f.sel('Level', 'level', [[0, 'Cantrip'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => [l, `Level ${l}`])], { rerender: true }),
        f.sel('School', 'school', SCHOOLS),
        f.text('Casting time', 'castingTime', { list: 'hb-cast-times' }),
        f.check('Ritual', 'ritual'),
        f.text('Range', 'range', { placeholder: '60 feet' }),
        f.check('Verbal (V)', 'components.verbal'),
        f.check('Somatic (S)', 'components.somatic'),
        f.check('Material (M)', 'components.hasMaterial', { rerender: true }),
        form.components?.hasMaterial ? f.text('Material', 'components.materialText', { placeholder: 'a pinch of sulfur' }) : '',
        f.text('Duration', 'durationBase', { list: 'hb-durations' }),
        f.check('Concentration', 'concentration'),
      )}
      <datalist id="hb-cast-times">${['Action', 'Bonus Action', 'Reaction, which you take when…', '1 minute', '10 minutes', '1 hour'].map((t) => html`<option value="${t}"></option>`)}</datalist>
      <datalist id="hb-durations">${['Instantaneous', '1 round', '1 minute', '10 minutes', '1 hour', '8 hours', '24 hours', 'Until dispelled'].map((t) => html`<option value="${t}"></option>`)}</datalist>
      ${f.multi('Classes that can learn it', 'classes', ctx.classNames)}
      ${f.section(
        'Rules text',
        f.area('Description', 'description', { rows: 6 }),
        Number(form.level) === 0 ? f.area('Cantrip upgrade', 'cantripUpgrade', { rows: 2 }) : f.area('Using a higher-level spell slot', 'higherLevels', { rows: 2 }),
      )}
      ${f.section(
        'At the table',
        html`<p class="hint wide">How the table rolls this spell when someone casts it.</p>`,
        f.sel('It…', 'mechanics.kind', [['other', 'Has nothing to roll'], ['attack', 'Makes a spell attack'], ['save', 'Forces a saving throw'], ['heal', 'Heals'], ['auto', 'Hits automatically']], { rerender: true }),
        kind === 'attack' ? f.sel('Attack', 'mechanics.attackType', [['ranged', 'Ranged spell attack'], ['melee', 'Melee spell attack']]) : '',
        kind === 'save' ? f.sel('Saving throw', 'mechanics.save', ABILITY_OPTIONS) : '',
        kind === 'save' ? f.check('Half damage on a success', 'mechanics.half') : '',
        ['attack', 'save', 'auto'].includes(kind) ? f.text('Damage dice', 'mechanics.damage', { placeholder: '3d6', max: 30 }) : '',
        ['attack', 'save', 'auto'].includes(kind) ? f.sel('Damage type', 'mechanics.damageType', DAMAGE_TYPES) : '',
        kind === 'heal' ? f.text('Healing dice', 'mechanics.heal', { placeholder: '2d8', max: 30 }) : '',
        kind === 'heal' ? f.check('Add the spellcasting modifier', 'mechanics.addMod') : '',
        kind === 'save' || kind === 'attack' ? f.sel('Condition on a hit or failed save', 'mechanics.condition', CONDITIONS, { blank: 'None' }) : '',
        kind !== 'other'
          ? f.text(Number(form.level) === 0 ? 'Extra dice at levels 5, 11 and 17' : 'Extra dice per slot level above', 'mechanics.upcast', { placeholder: '1d6', max: 10 })
          : '',
        kind !== 'other' ? f.sel('Area', 'mechanics.areaShape', [['circle', 'Sphere / circle (radius)'], ['cone', 'Cone'], ['line', 'Line (5 ft. wide)'], ['cube', 'Cube']], { blank: 'No area: pick targets', rerender: true }) : '',
        kind !== 'other' && m.areaShape ? f.num('Area size (feet)', 'mechanics.areaSize', { min: 5, max: 500, step: 5 }) : '',
        kind !== 'other' && m.areaShape && ['circle', 'cube'].includes(m.areaShape) ? f.check('Centred on the caster', 'mechanics.areaSelf') : '',
        kind !== 'other' && !m.areaShape ? f.num('Targets', 'mechanics.targets', { min: 1, max: 20 }) : '',
      )}`;
  },

  weapon(f, form) {
    return html`
      ${f.section(
        'Basics',
        f.text('Name', 'name'),
        f.sel('Category', 'category', ['Simple', 'Martial']),
        f.sel('Melee or ranged', 'kind', [['melee', 'Melee'], ['ranged', 'Ranged']]),
        f.text('Damage dice', 'damage.dice', { placeholder: '1d8', max: 20 }),
        f.sel('Damage type', 'damage.type', DAMAGE_TYPES),
        f.sel('Mastery', 'mastery', MASTERIES, { blank: 'None' }),
        f.text('Weight', 'weight', { placeholder: '3 lb.' }),
        f.text('Cost', 'cost', { placeholder: '15 GP' }),
      )}
      ${f.multi('Properties', 'propertyList', WEAPON_PROPERTIES)}
      ${f.section(
        'Property details',
        f.text('Range (Thrown or Ammunition)', 'range', { placeholder: '20/60', max: 20 }),
        f.text('Ammunition', 'ammo', { placeholder: 'Arrow' }),
        f.text('Versatile damage', 'versatileDice', { placeholder: '1d10', max: 20 }),
        f.text('Other properties', 'otherProperties', { placeholder: 'Comma separated' }),
      )}
      ${f.section(
        'Magic',
        f.check('Magic weapon', 'isMagic', { rerender: true }),
        form.isMagic ? f.sel('Bonus to attack and damage', 'bonus', [[0, 'None'], [1, '+1'], [2, '+2'], [3, '+3']]) : '',
        form.isMagic ? f.sel('Rarity', 'rarity', RARITIES) : '',
        form.isMagic ? f.check('Requires attunement', 'attunement') : '',
        f.area('Description', 'description', { rows: 4 }),
      )}`;
  },

  armor(f, form) {
    const cat = form.category || 'Light';
    return f.section(
      'Armor',
      f.text('Name', 'name'),
      f.sel('Category', 'category', ['Light', 'Medium', 'Heavy', 'Shield'], { rerender: true }),
      f.num(cat === 'Shield' ? 'AC bonus' : 'Base AC', 'baseAc', { min: 0, max: 30 }),
      cat === 'Medium' ? f.num('Max Dex bonus', 'maxDex', { min: 0, max: 10 }) : '',
      cat === 'Heavy' ? f.num('Strength needed', 'strength', { min: 0, max: 30, hint: 'Blank = none' }) : '',
      cat !== 'Shield' ? f.check('Disadvantage on Stealth', 'stealthDisadvantage') : '',
      f.text('Weight', 'weight'),
      f.text('Cost', 'cost'),
      f.area('Description', 'description', { rows: 3 }),
    );
  },

  class(f, form, ctx) {
    const type = form.casterType || 'none';
    return html`
      ${f.section(
        'Basics',
        f.text('Name', 'name'),
        f.sel('Hit die', 'hitDie', [[6, 'd6'], [8, 'd8'], [10, 'd10'], [12, 'd12']]),
        f.text('Primary ability', 'primaryAbility', { placeholder: 'Strength or Dexterity' }),
        f.sel('Unarmored Defense', 'unarmoredDefense', ABILITY_OPTIONS.filter(([k]) => k !== 'dex'), { blank: 'None', hint: 'Without armor, AC = 10 + Dex + this' }),
        f.area('Description', 'description', { rows: 3 }),
      )}
      ${f.multi('Saving throw proficiencies', 'savingThrows', Object.values(ABILITY_NAMES), { hint: 'Pick two.' })}
      ${f.section('Skills', f.num('Skills to choose', 'skillCount', { min: 0, max: 18 }))}
      ${f.multi('Skills they can choose from', 'skillOptions', Object.keys(SKILLS))}
      ${f.section(
        'Training',
        f.text('Weapon proficiencies', 'weaponProficiencies', { placeholder: 'Simple weapons and Martial weapons' }),
        f.text('Armor training', 'armorTraining', { placeholder: 'Light and Medium armor and Shields' }),
        f.text('Tool proficiencies', 'toolProficiencies'),
        f.area('Starting equipment', 'startingEquipment', { rows: 2, hint: 'Write it like "Choose A or B: (A) Spear, Explorer\'s Pack, and 10 GP; or (B) 50 GP" so the builder can hand it out.' }),
      )}
      ${f.section(
        'Spellcasting',
        f.sel('Casting', 'casterType', CASTER_TYPES, { rerender: true }),
        type !== 'none' ? f.sel('Spellcasting ability', 'spellAbility', ABILITY_OPTIONS) : '',
        type !== 'none'
          ? f.sel('Spell list', 'spellList', [['', 'Its own (spells that list this class)'], ...ctx.builtInClassNames.map((n) => [n, `The ${n} list`])])
          : '',
      )}
      ${f.list('Features by level', 'features', (p) => featureFields(f, p), {
        add: 'Add a feature',
        template: 'classFeature',
        hint: 'Subclass at level 3, Ability Score Improvements at 4, 8, 12 and 16, and an Epic Boon at 19 are added for you.',
      })}`;
  },

  subclass(f, form, ctx) {
    return html`
      ${f.section(
        'Basics',
        f.sel('Class', 'classId', ctx.classOptions),
        f.text('Name', 'name'),
        f.text('Tagline', 'tagline', { placeholder: 'Wield the Storm' }),
        f.area('Description', 'description', { rows: 3 }),
      )}
      ${f.list('Features by level', 'features', (p) => featureFields(f, p, { minLevel: 3 }), { add: 'Add a feature', template: 'subclassFeature' })}
      ${f.list('Always-prepared spells', 'alwaysPrepared', (p) => html`${f.num('Class level', `${p}.level`, { min: 1, max: 20 })}${f.csv('Spells', `${p}.spells`, { placeholder: 'Burning Hands, Thunderwave' })}`, {
        add: 'Add a level',
        template: 'alwaysPrepared',
        hint: 'Spell names, comma separated. They show up on the sheet as always prepared.',
      })}`;
  },

  species(f) {
    return html`
      ${f.section(
        'Basics',
        f.text('Name', 'name'),
        f.text('Creature type', 'creatureType', { list: 'hb-creature-types' }),
        f.text('Size', 'size', { placeholder: 'Medium (about 4–6 feet tall)' }),
        f.num('Speed (feet)', 'speed', { min: 0, max: 120, step: 5 }),
        f.num('Darkvision (feet)', 'darkvision', { min: 0, max: 300, step: 30, hint: 'Blank = none' }),
        f.area('Description', 'lore', { rows: 3 }),
      )}
      <datalist id="hb-creature-types">${CREATURE_TYPES.map((t) => html`<option value="${t}"></option>`)}</datalist>
      ${f.list('Traits', 'traits', (p) => html`${f.text('Name', `${p}.name`)}${f.area('Text', `${p}.text`, { rows: 3 })}`, { add: 'Add a trait', template: 'traits' })}`;
  },

  background(f, form, ctx) {
    return html`
      ${f.section('Basics', f.text('Name', 'name'), f.sel('Origin feat', 'feat', ctx.originFeats), f.text('Tool proficiency', 'toolProficiency'), f.area('Equipment', 'equipment', { rows: 2 }), f.area('Description', 'lore', { rows: 3 }))}
      ${f.multi('Ability scores (pick three)', 'abilityScores', Object.values(ABILITY_NAMES), { max: 3 })}
      ${f.multi('Skill proficiencies (pick two)', 'skillProficiencies', Object.keys(SKILLS), { max: 2 })}`;
  },

  feat(f) {
    return html`
      ${f.section(
        'Basics',
        f.text('Name', 'name'),
        f.sel('Type', 'category', FEAT_CATEGORIES),
        f.text('Prerequisite', 'prerequisite', { placeholder: 'Level 4+' }),
        f.check('Can be taken more than once', 'repeatable'),
      )}
      ${f.multi('Ability score increase (+1 to one of these)', 'abilityIncrease', ABILITY_OPTIONS, { hint: 'Optional. The level-up screen lets the player pick one.' })}
      ${f.section('Benefits', f.area('What it does', 'body', { rows: 8 }))}`;
  },

  'magic-item'(f, form, ctx) {
    const weapon = form.category === 'Weapon';
    return f.section(
      'Magic item',
      f.text('Name', 'name'),
      f.sel('Type', 'category', ITEM_CATEGORIES, { rerender: true }),
      f.sel('Rarity', 'rarity', RARITIES),
      f.check('Requires attunement', 'attunement', { rerender: true }),
      form.attunement ? f.text('Attunement by', 'attunementBy', { placeholder: 'a Wizard (optional)' }) : '',
      weapon ? f.sel('Base weapon', 'baseWeapon', ctx.weaponOptions, { blank: 'Any weapon (no attack on the sheet)' }) : '',
      weapon ? f.sel('Bonus to attack and damage', 'bonus', [[0, 'None'], [1, '+1'], [2, '+2'], [3, '+3']]) : '',
      f.area('Description', 'description', { rows: 8 }),
    );
  },
};

/** The whole form for a kind. ctx has the option lists (classes, feats, weapons). */
export function homebrewForm(kind, form, ctx) {
  return FORMS[kind](makeFields(form), form, ctx);
}
