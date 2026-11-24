// The "Level up" dialog: shows what the next level brings and asks for the
// choices the rules leave to the player (HP, subclass, ability scores or a feat).
import { html, raw, rulesMarkdown } from '../lib/dom.js';
import { ABILITIES, ABILITY_LABELS, featAbilityIncrease } from '../lib/character/rules.js';
import { subclassLabel } from '../lib/srd.js';
import { levelUpInfo, applyLevelUp } from '../lib/character/automation.js';
import { rollDie } from '../lib/dice.js';

/** Resolves with the levelled-up character, or null if cancelled. */
export function levelUpDialog(c, srd) {
  const info = levelUpInfo(c, srd);
  if (!info) return Promise.resolve(null);
  const feats = srd.feats.filter((f) =>
    info.epicBoon ? /Epic Boon|General/.test(f.category) : f.category === 'General Feat' && f.name !== 'Ability Score Improvement',
  );
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog levelup-dialog';
    let rolled = null;
    dlg.innerHTML = String(html`
      <form method="dialog" class="stack">
        <h2>Level ${info.level}</h2>
        <p class="muted">Proficiency Bonus +${info.proficiencyBonus}</p>

        <fieldset>
          <legend>Hit Points</legend>
          <label class="check"><input type="radio" name="hp" value="average" checked> Take the average: ${info.hpAverage} ${signedMod(info.conMod)} Con</label>
          <label class="check"><input type="radio" name="hp" value="roll"> Roll a d${info.hitDie} ${signedMod(info.conMod)} Con <span class="rolled muted"></span></label>
        </fieldset>

        ${info.needsSubclass
          ? html`<label>Choose your subclass
              <select name="subclass" required>${info.subclasses.map((s) => html`<option value="${s.id}">${subclassLabel(s)}</option>`)}</select></label>`
          : ''}

        ${info.asi || info.epicBoon
          ? html`<fieldset>
              <legend>${info.epicBoon ? 'Epic Boon' : 'Ability Score Improvement'}</legend>
              <label class="check"><input type="radio" name="asi-kind" value="two" checked> +2 to one score</label>
              <label class="check"><input type="radio" name="asi-kind" value="split"> +1 to two scores</label>
              <label class="check"><input type="radio" name="asi-kind" value="feat"> Take a feat instead</label>
              <div class="row asi-pick">
                <label>First <select name="asi1">${ABILITIES.map((a) => html`<option value="${a}">${ABILITY_LABELS[a]}</option>`)}</select></label>
                <label class="asi2" hidden>Second <select name="asi2">${ABILITIES.map((a, i) => html`<option value="${a}" ${raw(i === 1 ? 'selected' : '')}>${ABILITY_LABELS[a]}</option>`)}</select></label>
                <label class="feat-pick" hidden>Feat <select name="feat">${feats.map((f) => html`<option value="${f.name}">${f.name}${f.source && f.source !== 'srd' ? ` [${f.sourceName}]` : ''}${f.prerequisite ? ` (${f.prerequisite})` : ''}</option>`)}</select></label>
                <label class="feat-ability" hidden>Raise <select name="feat-ability"></select></label>
              </div>
              <p class="muted small">Scores can't go above 20.</p>
            </fieldset>`
          : ''}

        ${info.features.length
          ? html`<h3>New features</h3>${info.features.map((f) => html`<details><summary>${f.name}</summary>${raw(rulesMarkdown(f.description))}</details>`)}`
          : ''}
        ${info.spells
          ? html`<p class="callout">${info.spells.newSlotLevel ? html`You can now cast <strong>level ${info.spells.newSlotLevel}</strong> spells. ` : ''}
              ${info.spells.cantrips > 0 ? `You learn ${info.spells.cantrips} more cantrip${info.spells.cantrips > 1 ? 's' : ''}. ` : ''}
              ${info.spells.prepared > 0 ? `You can prepare ${info.spells.prepared} more spell${info.spells.prepared > 1 ? 's' : ''}. ` : ''}
              Spell slots update automatically. Pick new spells with <strong>Edit in builder</strong> afterwards.</p>`
          : ''}
        <p class="error" role="alert" hidden></p>
        <div class="dialog-actions">
          <button value="cancel" class="button secondary" formnovalidate>Cancel</button>
          <button value="ok" class="button">Level up</button>
        </div>
      </form>`);
    document.body.append(dlg);
    const form = dlg.querySelector('form');
    const err = dlg.querySelector('.error');

    form.addEventListener('change', (e) => {
      if (e.target.name === 'hp' && e.target.value === 'roll' && rolled == null) {
        rolled = rollDie(info.hitDie);
        dlg.querySelector('.rolled').textContent = `→ rolled ${rolled}`;
      }
      if (e.target.name === 'asi-kind') {
        const k = e.target.value;
        dlg.querySelector('.asi2').hidden = k !== 'split';
        dlg.querySelector('.feat-pick').hidden = k !== 'feat';
        dlg.querySelector('[name=asi1]').closest('label').hidden = k === 'feat';
      }
      if (e.target.name === 'asi-kind' || e.target.name === 'feat') showFeatAbility();
    });

    // A feat that raises an ability score: ask which one.
    function showFeatAbility() {
      const box = dlg.querySelector('.feat-ability');
      if (!box) return;
      const on = form.querySelector('[name=asi-kind]:checked')?.value === 'feat';
      const inc = on ? featAbilityIncrease(feats.find((x) => x.name === form.querySelector('[name=feat]').value)) : null;
      box.hidden = !inc;
      box.querySelector('select').innerHTML = inc
        ? String(html`${inc.options.map((a) => html`<option value="${a}">${ABILITY_LABELS[a]} +${inc.amount}</option>`)}`)
        : '';
    }

    let result = null;
    form.addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'ok') return;
      const f = new FormData(form);
      const choice = { hp: f.get('hp') === 'roll' ? rolled : 'average', subclassId: f.get('subclass') || undefined };
      const kind = f.get('asi-kind');
      if (kind === 'feat') {
        choice.feat = f.get('feat');
        choice.featAbility = f.get('feat-ability') || undefined;
      }
      else if (kind === 'two') choice.asi = { [f.get('asi1')]: 2 };
      else if (kind === 'split') {
        if (f.get('asi1') === f.get('asi2')) {
          e.preventDefault();
          err.textContent = 'Choose two different scores.';
          err.hidden = false;
          return;
        }
        choice.asi = { [f.get('asi1')]: 1, [f.get('asi2')]: 1 };
      }
      try {
        result = applyLevelUp(c, srd, choice);
      } catch (ex) {
        e.preventDefault();
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' ? result : null);
      dlg.remove();
    });
    dlg.showModal();
  });
}

function signedMod(n) {
  return n >= 0 ? `+ ${n}` : `− ${Math.abs(n)}`;
}
