import { html } from '../lib/dom.js';
import { getAuth, updateDisplayName } from '../lib/auth.js';

export function renderAccount(root) {
  const { session, profile } = getAuth();

  root.innerHTML = String(html`
    <section class="page narrow">
      <div class="card">
        <h1>Your account</h1>
        <p class="muted">Signed in as ${session.user.email}</p>
        ${profile?.missingTable
          ? html`<p class="message error">The database isn't set up yet, so your name can't be saved. Run <code>supabase/migrations/0001_profiles.sql</code> in the Supabase SQL editor.</p>`
          : ''}
        <form id="name-form">
          <label for="display-name">Display name</label>
          <p class="hint">This is the name your party and Dungeon Master will see.</p>
          <input id="display-name" name="name" maxlength="40" required value="${profile?.display_name || ''}" />
          <button type="submit" class="button">Save</button>
        </form>
        <p class="message" role="status" aria-live="polite"></p>
      </div>
    </section>`);

  const form = root.querySelector('#name-form');
  const status = root.querySelector('.message[role=status]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    status.className = 'message';
    status.textContent = 'Saving…';
    try {
      await updateDisplayName(form.name.value);
      status.className = 'message success';
      status.textContent = 'Saved.';
    } catch (err) {
      status.className = 'message error';
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}
