import { html } from '../lib/dom.js';
import { loadSrd } from '../lib/srd.js';

export async function renderCredits(root) {
  const index = await loadSrd('index');
  root.innerHTML = String(html`
    <section class="page narrow">
      <h1>Credits</h1>
      <p>${index.attribution}</p>
      <p>Dungeons &amp; Dragons and D&amp;D are trademarks of Wizards of the Coast LLC. This site is not affiliated with or endorsed by Wizards of the Coast.</p>
    </section>`);
}
