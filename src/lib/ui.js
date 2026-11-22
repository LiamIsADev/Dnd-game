// Small shared UI pieces: an in-page confirm dialog and toast messages.
import { esc } from './dom.js';

/** Ask a yes/no question in a page dialog. Resolves true if confirmed. */
export function confirmDialog({ title, message, confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = `
      <form method="dialog">
        <h2>${esc(title)}</h2>
        <p>${esc(message)}</p>
        <div class="dialog-actions">
          <button value="cancel" class="button secondary">Cancel</button>
          <button value="ok" class="button ${danger ? 'danger' : ''}">${esc(confirmLabel)}</button>
        </div>
      </form>`;
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    dlg.showModal();
    dlg.querySelector('button[value=cancel]').focus();
  });
}

let toastHost;
/** Show a short message at the bottom of the screen. */
export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastHost.append(el);
  setTimeout(() => el.classList.add('hide'), 3500);
  setTimeout(() => el.remove(), 4000);
}
