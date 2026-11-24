// Renders a monster stat block. Used by the rules browser now, and later by
// the Dungeon Master's view when spawning enemies on the map.
import { html, raw, rulesMarkdown } from '../lib/dom.js';
import { ABILITY_NAMES, formatMod } from '../lib/srd.js';

export function statBlock(m) {
  const sizeType = `${m.size.join(' or ')} ${m.type}, ${m.alignment}`;
  const abilities = Object.entries(ABILITY_NAMES).map(([key, label]) => {
    const a = m.abilities[key];
    return html`<div class="ability">
      <abbr title="${label}">${key.toUpperCase()}</abbr>
      <span class="score">${a?.score ?? '—'}</span>
      <span class="mods"><span title="Modifier">${formatMod(a?.mod)}</span> <span title="Saving throw">${formatMod(a?.save)}</span></span>
    </div>`;
  });
  const line = (label, value) => (value ? html`<p><strong>${label}</strong> ${value}</p>` : '');
  const cr = m.cr?.rating
    ? `${m.cr.rating} (XP ${m.cr.xp.toLocaleString()}${m.cr.xpInLair ? `, or ${m.cr.xpInLair.toLocaleString()} in lair` : ''}; PB +${m.cr.proficiencyBonus})`
    : m.cr?.raw;
  const section = (title, items, intro) =>
    items?.length
      ? html`<h3>${title}</h3>${intro ? html`<p class="intro">${raw(inline(intro))}</p>` : ''}${items.map(
          (a) => html`<div class="entry">${raw(rulesMarkdown(`***${a.name ? a.name + '.' : ''}*** ${a.text}`))}</div>`,
        )}`
      : '';

  return html`
    <article class="statblock">
      <header>
        <h2>${m.name}</h2>
        <p class="meta">${sizeType}${m.sourceName && m.source !== 'srd' ? ` · ${m.sourceName}` : ''}</p>
      </header>
      <div class="stats">
        ${line('AC', m.ac)} ${line('Initiative', m.initiative ? `${formatMod(m.initiative.bonus)} (${m.initiative.score})` : '')}
        ${line('HP', m.hp ? `${m.hp.average}${m.hp.formula ? ` (${m.hp.formula.replace(/\+/g, ' + ')})` : ''}` : '')}
        ${line('Speed', m.speed)}
      </div>
      <div class="abilities">${abilities}</div>
      <div class="stats">
        ${line('Skills', m.skills)} ${line('Vulnerabilities', m.vulnerabilities)} ${line('Resistances', m.resistances)}
        ${line('Immunities', m.immunities)} ${line('Gear', m.gear)} ${line('Senses', m.senses)}
        ${line('Languages', m.languages)} ${line('CR', cr)}
      </div>
      ${section('Traits', m.traits)} ${section('Actions', m.actions)} ${section('Bonus Actions', m.bonusActions)}
      ${section('Reactions', m.reactions)} ${section('Legendary Actions', m.legendaryActions, m.legendaryActionsIntro)}
      ${m.mythicTrait ? html`${section('Mythic Trait', [m.mythicTrait])}${section('Mythic Actions', m.mythicActions, m.mythicActionsIntro)}` : ''}
    </article>`;
}

function inline(md) {
  return rulesMarkdown(md).replace(/^<p>|<\/p>\s*$/g, '');
}
