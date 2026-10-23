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
    // See admin-fields.js's el() for why: a type-less <button> defaults
    // to submit and silently fires the surrounding <form> on click.
    if (tag === 'button') e.type = 'button';
    return e;
  }

  function safeParse(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }

  // Featured-tags list — stars a tag so it's pinned to the top of the
  // home page's tag widget. Click any tag pill to toggle; works even for
  // a tag nobody's used yet to feature it preemptively (the endpoint
  // creates the tag row if it doesn't already exist).
  function initFeaturedTags(writable) {
    const listEl = document.getElementById('settings-tags-list');
    if (!listEl) return;

    function render(tags, featured) {
      listEl.innerHTML = '';
      const featuredSet = new Set(featured);
      [...tags].sort((a, b) => a.localeCompare(b)).forEach((name) => {
        const isFeatured = featuredSet.has(name);
        const pill = el('button', 'pill pill-toggle' + (isFeatured ? ' active' : ''), (isFeatured ? '★ ' : '') + name);
        if (!writable) pill.disabled = true;
        pill.addEventListener('click', async () => {
          if (!writable) return;
          pill.disabled = true;
          try {
            await api.put('/api/tags/featured', { name, featured: !isFeatured });
            load();
          } catch (e) {
            alert(e.message || 'Could not update.');
            pill.disabled = false;
          }
        });
        listEl.appendChild(pill);
      });
      if (!tags.length) listEl.innerHTML = '<p class="state-msg">No tags yet — tags appear here once used on a post, event, or video.</p>';
    }

    function load() {
      api.get('/api/tags').then(({ tags, featured }) => render(tags || [], featured || [])).catch(() => {
        listEl.innerHTML = '<p class="state-msg">Could not load tags.</p>';
      });
    }
    load();
  }

  function init() {
    const form = document.getElementById('settings-form');
    const urlInput = document.getElementById('settings-newsletter-url');
    const gmapsInput = document.getElementById('settings-gmaps-key');
    const listEl = document.getElementById('footer-buttons-list');
    const addBtn = document.getElementById('footer-buttons-add');
    const msg = document.getElementById('settings-msg');
    initFeaturedTags(canWrite());
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
      if (gmapsInput) gmapsInput.value = settings.gmaps_api_key || '';
      buttons = safeParse(settings.footer_buttons, []);
      if (!Array.isArray(buttons)) buttons = [];
      renderButtons();
    }).catch(() => {});

    if (!writable) {
      urlInput.disabled = true;
      if (gmapsInput) gmapsInput.disabled = true;
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
            gmaps_api_key: gmapsInput ? gmapsInput.value.trim() : '',
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
