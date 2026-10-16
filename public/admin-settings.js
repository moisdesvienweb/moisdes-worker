// ================================================================
// MOISDES ADMIN — Site settings (newsletter link, custom footer buttons)
// admin-settings.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminSettings = (function () {
  const api = window.MOISDES.api;

  function canWrite() {
    const role = api.getUser()?.role;
    if (role === 'admin' || role === 'superadmin') return true;
    return !!api.getPermissions()?.settings?.write;
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function safeParse(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }

  function init() {
    const form = document.getElementById('settings-form');
    const urlInput = document.getElementById('settings-newsletter-url');
    const listEl = document.getElementById('footer-buttons-list');
    const addBtn = document.getElementById('footer-buttons-add');
    const msg = document.getElementById('settings-msg');
    if (!form) return;

    const writable = canWrite();
    let buttons = []; // { label, url }

    function renderButtons() {
      listEl.innerHTML = '';
      buttons.forEach((btn, i) => {
        const row = el('div', 'footer-btn-row');
        const labelInput = el('input');
        labelInput.type = 'text';
        labelInput.placeholder = 'Button text';
        labelInput.value = btn.label;
        labelInput.disabled = !writable;
        labelInput.addEventListener('input', () => { btn.label = labelInput.value; });
        const urlField = el('input');
        urlField.type = 'text';
        urlField.placeholder = 'https://... or /form.html?slug=...';
        urlField.value = btn.url;
        urlField.disabled = !writable;
        urlField.addEventListener('input', () => { btn.url = urlField.value; });
        row.appendChild(labelInput);
        row.appendChild(urlField);
        if (writable) {
          const rm = el('button', 'btn btn-sm btn-danger', 'Remove');
          rm.type = 'button';
          rm.addEventListener('click', () => { buttons.splice(i, 1); renderButtons(); });
          row.appendChild(rm);
        }
        listEl.appendChild(row);
      });
    }

    api.get('/api/settings').then(({ settings }) => {
      urlInput.value = settings.newsletter_url || '';
      buttons = safeParse(settings.footer_buttons, []);
      if (!Array.isArray(buttons)) buttons = [];
      renderButtons();
    }).catch(() => {});

    if (!writable) {
      urlInput.disabled = true;
      addBtn.style.display = 'none';
      form.querySelector('button[type=submit]').style.display = 'none';
      msg.textContent = "View only — you don't have write access to Settings.";
      return;
    }

    addBtn.addEventListener('click', () => {
      buttons.push({ label: '', url: '' });
      renderButtons();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = 'Saving…';
      msg.className = 'state-msg';
      try {
        const cleanButtons = buttons
          .map((b) => ({ label: (b.label || '').trim(), url: (b.url || '').trim() }))
          .filter((b) => b.label && b.url);
        await api.put('/api/settings', {
          settings: {
            newsletter_url: urlInput.value.trim(),
            footer_buttons: JSON.stringify(cleanButtons),
          },
        });
        msg.textContent = 'Saved.';
        msg.className = 'state-msg ok';
      } catch (err) {
        msg.textContent = err.message || 'Save failed';
        msg.className = 'state-msg err';
      }
    });
  }

  return { init };
})();
