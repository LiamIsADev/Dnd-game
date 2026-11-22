// #/campaigns: start a campaign as the DM, or join one with a code.
// #/join/CODE: the invite link players get from their DM.
import { html } from '../lib/dom.js';
import { getAuth } from '../lib/auth.js';
import { toast } from '../lib/ui.js';
import { listCampaigns, createCampaign, joinCampaign } from '../lib/campaign/store.js';

export async function renderCampaigns(root, { navigate }) {
  const me = getAuth().session.user.id;
  root.innerHTML = String(html`
    <section class="page">
      <h1 class="page-title">Campaigns</h1>
      <div class="campaign-actions">
        <form class="card stack" data-form="create">
          <h2>Start a campaign</h2>
          <p class="muted">You'll be the Dungeon Master. You get a code to share with your party.</p>
          <label>Campaign name <input name="name" maxlength="80" required placeholder="The Lost Mine"></label>
          <button class="button">Create campaign</button>
        </form>
        ${joinForm()}
      </div>
      <h2>Your campaigns</h2>
      <div class="campaign-grid"><p class="loading">Loading…</p></div>
    </section>`);
  wireJoin(root, navigate);

  root.querySelector('[data-form=create]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const id = await createCampaign(new FormData(e.target).get('name'));
      navigate(`/campaigns/${id}`);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  const grid = root.querySelector('.campaign-grid');
  try {
    const list = await listCampaigns(me);
    grid.innerHTML = list.length
      ? String(html`${list.map(
          (c) => html`<a class="card campaign-card" href="#/campaigns/${c.id}">
            <span class="badge ${c.role}">${c.role === 'dm' ? 'You are the DM' : 'Player'}</span>
            <h3>${c.name}</h3>
            <p class="muted small">${c.role === 'dm' ? `Join code ${c.join_code}` : `DM: ${c.dmName}`}</p>
          </a>`,
        )}`)
      : '<p class="muted">No campaigns yet. Start one, or join with a code from your DM.</p>';
  } catch (err) {
    grid.innerHTML = String(html`<p class="error">${err.message}</p>`);
  }
}

/** The "join with a code" box, also used on the home screen. */
export function joinForm(code = '') {
  return html`<form class="card stack join-form" data-form="join">
    <h2>Join a campaign</h2>
    <p class="muted">Type the 6-letter code your DM gave you.</p>
    <label class="sr-only" for="join-code">Join code</label>
    <div class="row">
      <input id="join-code" name="code" class="code-input" maxlength="8" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC234" value="${code}">
      <button class="button">Join</button>
    </div>
  </form>`;
}

export function wireJoin(root, navigate) {
  const form = root.querySelector('[data-form=join]');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = String(new FormData(form).get('code')).trim().toUpperCase();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const id = await joinCampaign(code);
      toast('You joined the campaign!', 'success');
      navigate(`/campaigns/${id}`);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

export async function renderJoin(root, { params, navigate }) {
  const code = String(params[0] || '').toUpperCase();
  root.innerHTML = '<p class="loading">Joining…</p>';
  try {
    const id = await joinCampaign(code);
    navigate(`/campaigns/${id}`);
  } catch (err) {
    root.innerHTML = String(html`<section class="page narrow">
      <p class="error">${err.message}</p>
      ${joinForm(code)}
    </section>`);
    wireJoin(root, navigate);
  }
}
