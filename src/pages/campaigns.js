import { html } from '../lib/dom.js';

// Placeholder until step 3 (the live table).
export function renderCampaigns(root) {
  root.innerHTML = String(html`
    <section class="page narrow">
      <div class="card">
        <h1>Campaigns</h1>
        <p>Campaigns are coming in the next step. You'll be able to:</p>
        <ul>
          <li>Start a campaign as the Dungeon Master and invite your party with a link</li>
          <li>Bring one of your saved characters into a campaign</li>
          <li>Play live on a grid battle map with fog of war and digital dice</li>
        </ul>
        <p>For now, get your party ready by <a href="#/characters/new">creating a character</a>.</p>
      </div>
    </section>`);
}
