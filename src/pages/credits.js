import { html } from '../lib/dom.js';
import { loadSrd, loadOpen5eIndex } from '../lib/srd.js';

const LICENSE_NAMES = { 'ogl-10a': 'Open Game License 1.0a', 'cc-by-40': 'CC BY 4.0' };

export async function renderCredits(root) {
  const [index, extra] = await Promise.all([loadSrd('index'), loadOpen5eIndex()]);
  root.innerHTML = String(html`
    <section class="page narrow">
      <h1>Credits</h1>
      <p>${index.attribution}</p>
      ${extra
        ? html`
          <h2>More subclasses, spells and feats</h2>
          <p>${extra.attribution}</p>
          <ul>
            ${extra.sources.map(
              (s) => html`<li><strong>${s.title}</strong> (shown as “${s.short}”), ${s.publisher}${s.author && s.author !== s.publisher && !/not sure|various/i.test(s.author) ? `; ${s.author.replace(/\.+$/, '')}` : ''}.
                ${s.licenses.map((l) => LICENSE_NAMES[l] || l).join(' or ')}. <a href="${s.url}" rel="noopener" target="_blank">Source</a></li>`,
            )}
          </ul>
          <h3>Open Game License, Section 15: Copyright Notice</h3>
          <ul>${extra.section15.map((n) => html`<li>${n}</li>`)}</ul>
          <p>Open Game Content: all of the subclass, spell and feat text taken from the books above. Product Identity: the site's own name, code and design are not Open Game Content.</p>
          <details><summary>Open Game License Version 1.0a</summary><pre class="license">${extra.ogl}</pre></details>`
        : ''}
      <p>Dungeons &amp; Dragons and D&amp;D are trademarks of Wizards of the Coast LLC. This site is not affiliated with or endorsed by Wizards of the Coast, Kobold Press, Green Ronin Publishing, EN Publishing or Open5e.</p>
    </section>`);
}
