import { html } from '../lib/dom.js';
import { getAuth } from '../lib/auth.js';
import { loadSrd } from '../lib/srd.js';

export async function renderHome(root) {
  const { session, profile } = getAuth();
  root.innerHTML = String(html`
    <section class="hero">
      <h1>${session ? `Welcome back, ${profile?.display_name || 'adventurer'}` : 'Run your Fifth Edition campaigns online'}</h1>
      <p class="lead">Build characters, gather your party, and play live on a shared battle map. The site rolls the dice and keeps track of everything, and the Dungeon Master's secrets stay secret.</p>
      <div class="hero-actions">
        ${session
          ? html`<a class="button" href="#/rules">Browse the rules</a>`
          : html`<a class="button" href="#/sign-in">Sign in with email</a> <a class="button secondary" href="#/rules">Browse the rules</a>`}
      </div>
    </section>
    <section class="page">
      <h2>What's here so far</h2>
      <div class="tiles" id="counts"></div>
      <h2>Coming next</h2>
      <ul class="roadmap">
        <li><strong>Characters:</strong> a step-by-step character builder, digital sheets and a saved character library.</li>
        <li><strong>Live table:</strong> campaigns, invite links, a grid battle map with fog of war, and dice rolling.</li>
        <li><strong>Rules automation:</strong> initiative, attacks, damage, conditions and spell slots handled for you.</li>
      </ul>
    </section>`);

  try {
    const index = await loadSrd('index');
    const c = index.counts;
    const tiles = [
      ['Spells', c.spells, 'spells'],
      ['Monsters & animals', c.monsters, 'monsters'],
      ['Magic items', c['magic-items'], 'magic-items'],
      ['Classes', c.classes, 'classes'],
      ['Species', c.species, 'species'],
      ['Feats', c.feats, 'feats'],
    ];
    root.querySelector('#counts').innerHTML = String(
      html`${tiles.map(([label, n, id]) => html`<a class="tile" href="#/rules/${id}"><span class="tile-n">${n}</span><span>${label}</span></a>`)}`,
    );
  } catch {
    // Counts are a nice-to-have; ignore failures.
  }
}
