// ================================================================
// MOISDES ADMIN — Forms panel (builder + response viewer)
// admin-forms.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminForms = (function () {
  const api = window.MOISDES.api;

  const FIELD_TYPES = [
    ['text', 'Text'], ['textarea', 'Textarea'], ['select', 'Select'],
    ['radio', 'Radio'], ['checkbox', 'Checkbox'], ['date', 'Date'],
    ['email', 'Email'], ['phone', 'Phone'], ['file', 'File'],
    ['heading', 'Heading'], ['paragraph', 'Paragraph'],
  ];
  const HAS_OPTIONS = new Set(['select', 'radio', 'checkbox']);
  const HAS_PLACEHOLDER = new Set(['text', 'textarea', 'email', 'phone']);
  const NO_LABEL_FIELD = new Set(['heading', 'paragraph']);

  let formsListEl, detailEl;
  let forms = [];
  let activeFormId = null;
  // Bumped on every selectForm()/renderDetail() call; an in-flight async
  // load checks it before touching the DOM or any shared state, so
  // switching forms quickly can never have a slow-to-resolve fetch for
  // the PREVIOUS form overwrite data for the form actually on screen now.
  let renderToken = 0;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fieldGroup(labelText, inputEl) {
    const g = el('div', 'field-group');
    g.appendChild(el('label', '', labelText));
    g.appendChild(inputEl);
    return g;
  }
  function richTextField(labelText, initialHtml) {
    const host = el('div');
    const editor = window.MOISDES.richtext.createEditor(host, initialHtml || '');
    return { group: fieldGroup(labelText, host), editor };
  }
  function publicFormUrl(slug) {
    return `${location.origin}/form.html?slug=${encodeURIComponent(slug || '')}`;
  }
  function canWrite() {
    const role = api.getUser()?.role;
    if (role === 'admin' || role === 'superadmin') return true;
    return !!api.getPermissions()?.forms?.write;
  }

  async function loadForms() {
    formsListEl.innerHTML = '<li>Loading…</li>';
    try {
      const data = await api.get('/api/forms');
      forms = data.forms;
      renderFormsList();
      if (forms.length && !activeFormId) selectForm(forms[0].id);
    } catch (e) {
      formsListEl.innerHTML = `<li>${escapeHtml(e.message)}</li>`;
    }
  }

  // Lightweight re-fetch used for the periodic unread-notification poll —
  // only rebuilds the forms list (unread counts + nav badge), never
  // touches detailEl, so it can't clobber an in-progress field-builder
  // edit or a scrolled responses table for whichever form is open.
  async function refreshUnreadCounts() {
    try {
      const data = await api.get('/api/forms');
      forms = data.forms;
      renderFormsList();
    } catch (e) { /* silent — this is a background refresh, not a user action */ }
  }

  function updateNavBadge() {
    const badge = document.getElementById('forms-unread-badge');
    if (!badge) return;
    const total = forms.reduce((sum, f) => sum + (f.unread_count || 0), 0);
    badge.textContent = String(total);
    badge.style.display = total > 0 ? '' : 'none';
  }

  function renderFormsList() {
    formsListEl.innerHTML = '';
    forms.forEach((f) => {
      const li = el('li', f.id === activeFormId ? 'active' : '');
      const status = f.settings?.status === 'closed' ? ' (closed)' : '';
      const span = el('span', '', `${escapeHtml(f.title || '(untitled)')}${status}`);
      span.style.cursor = 'pointer';
      span.addEventListener('click', () => selectForm(f.id));
      li.appendChild(span);
      if (f.unread_count > 0) li.appendChild(el('span', 'nav-badge', String(f.unread_count)));
      if (canWrite()) {
        const dupBtn = el('button', 'btn btn-sm', 'Duplicate');
        dupBtn.style.marginInlineStart = '.5rem';
        dupBtn.addEventListener('click', (e) => { e.stopPropagation(); duplicateForm(f); });
        li.appendChild(dupBtn);
      }
      formsListEl.appendChild(li);
    });
    updateNavBadge();
  }

  // Creates a new form with the same settings + fields as `source`, then
  // selects it so the title/slug/fields can be edited right away — the
  // original is left untouched.
  async function duplicateForm(source) {
    try {
      const { id } = await api.post('/api/forms', {
        title: `Copy of ${source.title || 'form'}`,
        settings: source.settings || {},
      });
      const { fields: srcFields } = await api.get(`/api/forms/${source.id}/fields`);
      if (srcFields.length) await api.post(`/api/forms/${id}/fields`, { fields: srcFields });
      await loadForms();
      await selectForm(id);
    } catch (e) {
      alert(e.message || 'Could not duplicate form');
    }
  }

  async function selectForm(id) {
    activeFormId = id;
    renderFormsList();
    await renderDetail();
  }

  async function createForm() {
    const { id } = await api.post('/api/forms', { title: 'New form', settings: {} });
    await loadForms();
    await selectForm(id);
  }

  // -- Settings section --------------------------------------------------

  function renderSettingsSection(container, form, writable) {
    const wrap = el('div');
    wrap.appendChild(el('h2', '', 'Settings'));
    const settings = form.settings || {};

    const titleInput = el('input');
    titleInput.type = 'text';
    titleInput.value = form.title || '';
    wrap.appendChild(fieldGroup('Title', titleInput));

    const slugInput = el('input');
    slugInput.type = 'text';
    slugInput.value = form.slug || '';
    slugInput.placeholder = 'custom-url-slug';
    wrap.appendChild(fieldGroup('URL slug (letters, numbers, hyphens)', slugInput));

    const linkP = el('p', 'state-msg', '');
    function refreshLink() {
      const u = publicFormUrl(slugInput.value);
      linkP.innerHTML = `Public URL: <a href="${u}" target="_blank" rel="noopener">${u}</a>`;
    }
    refreshLink();
    slugInput.addEventListener('input', refreshLink);
    wrap.appendChild(linkP);

    const descField = richTextField('Description (shown above the form)', settings.description);
    wrap.appendChild(descField.group);

    const statusSelect = el('select');
    statusSelect.innerHTML = '<option value="open">Open</option><option value="closed">Closed</option>';
    statusSelect.value = settings.status === 'closed' ? 'closed' : 'open';
    wrap.appendChild(fieldGroup('Status', statusSelect));

    const thankTitle = el('input');
    thankTitle.type = 'text';
    thankTitle.value = settings.thankYouTitle || '';
    thankTitle.placeholder = 'א דאנק!';
    wrap.appendChild(fieldGroup('Thank-you title', thankTitle));

    const thankMsgField = richTextField('Thank-you message', settings.thankYouMessage);
    wrap.appendChild(thankMsgField.group);

    if (writable) {
      const saveBtn = el('button', 'btn btn-primary', 'Save settings');
      const status = el('span', 'status-msg', '');
      wrap.appendChild(saveBtn);
      wrap.appendChild(status);
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await api.put(`/api/forms/${form.id}`, {
            title: titleInput.value,
            slug: slugInput.value.trim().toLowerCase(),
            settings: {
              description: descField.editor.getHtml(),
              status: statusSelect.value,
              thankYouTitle: thankTitle.value,
              thankYouMessage: thankMsgField.editor.getHtml(),
            },
          });
          status.textContent = 'Saved.';
          status.className = 'status-msg ok';
          await loadForms();
        } catch (e) {
          status.textContent = e.message || 'Failed to save';
          status.className = 'status-msg err';
        }
        saveBtn.disabled = false;
      });

      const deleteBtn = el('button', 'btn btn-danger', 'Delete form');
      deleteBtn.style.marginLeft = '.5rem';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete this form and its responses?')) return;
        await api.del(`/api/forms/${form.id}`);
        activeFormId = null;
        await loadForms();
      });
      wrap.appendChild(deleteBtn);
    } else {
      [titleInput, slugInput, statusSelect, thankTitle].forEach((i) => { i.disabled = true; });
      [descField, thankMsgField].forEach((f) => { f.group.querySelector('.rte-editor').contentEditable = 'false'; });
      wrap.appendChild(el('p', 'state-msg', "View only — you don't have write access to Forms."));
    }

    container.appendChild(wrap);
  }

  // -- Field builder section ----------------------------------------------

  function renderFieldBuilderCard(field, index, fieldsArr, onChange) {
    const card = el('div', 'builder-field');
    const head = el('div', 'builder-field-head');
    head.appendChild(el('span', 'type-badge', field.type));
    head.appendChild(el('span', 'spacer'));

    const up = el('button', 'btn btn-sm', '&#9650;');
    up.type = 'button';
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      [fieldsArr[index - 1], fieldsArr[index]] = [fieldsArr[index], fieldsArr[index - 1]];
      onChange();
    });
    const down = el('button', 'btn btn-sm', '&#9660;');
    down.type = 'button';
    down.disabled = index === fieldsArr.length - 1;
    down.addEventListener('click', () => {
      [fieldsArr[index + 1], fieldsArr[index]] = [fieldsArr[index], fieldsArr[index + 1]];
      onChange();
    });
    const rm = el('button', 'btn btn-sm btn-danger', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', () => { fieldsArr.splice(index, 1); onChange(); });
    head.appendChild(up);
    head.appendChild(down);
    head.appendChild(rm);
    card.appendChild(head);

    const labelInput = el('input');
    labelInput.type = 'text';
    labelInput.value = field.label || '';
    labelInput.placeholder = NO_LABEL_FIELD.has(field.type) ? 'Text to display' : 'Field label';
    labelInput.addEventListener('input', () => { field.label = labelInput.value; });
    card.appendChild(fieldGroup('Label', labelInput));

    if (HAS_PLACEHOLDER.has(field.type)) {
      const ph = el('input');
      ph.type = 'text';
      ph.value = field.placeholder || '';
      ph.addEventListener('input', () => { field.placeholder = ph.value; });
      card.appendChild(fieldGroup('Placeholder', ph));
    }

    if (HAS_OPTIONS.has(field.type)) {
      const opts = el('input');
      opts.type = 'text';
      opts.value = (field.options || []).join(', ');
      opts.placeholder = 'Option 1, Option 2, Option 3';
      opts.addEventListener('input', () => { field.options = opts.value.split(',').map((s) => s.trim()).filter(Boolean); });
      card.appendChild(fieldGroup('Options (comma-separated)', opts));
    }

    if (!NO_LABEL_FIELD.has(field.type)) {
      const reqLabel = el('label');
      const reqInput = el('input');
      reqInput.type = 'checkbox';
      reqInput.checked = !!field.required;
      reqInput.style.width = 'auto';
      reqInput.addEventListener('change', () => { field.required = reqInput.checked; });
      reqLabel.appendChild(reqInput);
      reqLabel.appendChild(document.createTextNode(' Required'));
      card.appendChild(reqLabel);
    }

    return card;
  }

  // Returns the built (detached) section instead of appending itself —
  // renderDetail() only appends it after confirming this is still the
  // most recent form selected, so a slow-to-resolve fetch for a form the
  // admin has since navigated away from can never inject its markup into
  // whatever's now on screen.
  async function buildFieldBuilderSection(form, writable) {
    const wrap = el('div');
    wrap.appendChild(el('h2', '', 'Fields'));

    let fields = [];
    try {
      const { fields: loaded } = await api.get(`/api/forms/${form.id}/fields`);
      fields = loaded.map((f) => ({ type: f.type, label: f.label, placeholder: f.placeholder, options: f.options || [], required: !!f.required }));
    } catch (e) {
      fields = [];
    }

    if (writable) {
      const palette = el('div', 'field-palette');
      FIELD_TYPES.forEach(([type, label]) => {
        const btn = el('button', 'palette-btn', `+ ${label}`);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          fields.push({ type, label, placeholder: '', options: [], required: false });
          renderFieldList();
        });
        palette.appendChild(btn);
      });
      wrap.appendChild(palette);
    }

    const fieldListEl = el('div');
    wrap.appendChild(fieldListEl);

    function renderFieldList() {
      fieldListEl.innerHTML = '';
      fields.forEach((f, i) => fieldListEl.appendChild(renderFieldBuilderCard(f, i, fields, renderFieldList)));
    }
    renderFieldList();

    if (writable) {
      const saveBtn = el('button', 'btn btn-primary', 'Save fields');
      const status = el('span', 'status-msg', '');
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await api.post(`/api/forms/${form.id}/fields`, { fields });
          status.textContent = 'Saved.';
          status.className = 'status-msg ok';
        } catch (e) {
          status.textContent = e.message || 'Failed to save';
          status.className = 'status-msg err';
        }
        saveBtn.disabled = false;
      });
      wrap.appendChild(saveBtn);
      wrap.appendChild(status);
    }

    return wrap;
  }

  // -- Responses section ----------------------------------------------

  // Toggles one response's read/unread state, then keeps the sidebar's
  // per-form and nav-total unread badges in sync locally (no full
  // reload) by patching the matching entry in the already-loaded
  // `forms` array and re-running the cheap, detail-safe renderFormsList().
  async function toggleResponseRead(form, r, tr, btn) {
    const nextRead = !r.read_at;
    btn.disabled = true;
    try {
      await api.put(`/api/forms/${form.id}/responses/${r.id}/read`, { read: nextRead });
      r.read_at = nextRead ? new Date().toISOString() : null;
      tr.classList.toggle('response-row-unread', !r.read_at);
      btn.textContent = r.read_at ? 'Mark unread' : 'Mark read';
      const listForm = forms.find((f) => f.id === form.id);
      if (listForm) {
        listForm.unread_count = Math.max(0, (listForm.unread_count || 0) + (nextRead ? -1 : 1));
        renderFormsList();
      }
    } catch (e) {
      alert(e.message || 'Could not update read status.');
    }
    btn.disabled = false;
  }

  // Same detached-build pattern as buildFieldBuilderSection above.
  async function buildResponsesSection(form, writable) {
    const wrap = el('div', 'response-table-wrap');
    wrap.appendChild(el('h2', '', 'Responses'));
    const exportBtn = el('button', 'btn', 'Export XLSX');
    wrap.appendChild(exportBtn);
    const table = el('table');
    const tableWrap = el('div', 'table-wrap');
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);

    let responseFields = [], responseRows = [];
    try {
      const data = await api.get(`/api/forms/${form.id}/responses`);
      responseFields = data.fields;
      responseRows = data.responses;

      const thead = el('thead');
      thead.innerHTML = `<tr><th>Submitted</th>${responseFields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('')}${writable ? '<th>Read</th>' : ''}</tr>`;
      const tbody = el('tbody');
      if (!responseRows.length) {
        tbody.innerHTML = `<tr><td colspan="${responseFields.length + 1}">No responses yet.</td></tr>`;
      }
      responseRows.forEach((r) => {
        const tr = el('tr', r.read_at ? '' : 'response-row-unread');
        tr.innerHTML = `<td>${escapeHtml(r.submitted_at)}</td>` +
          responseFields.map((f) => `<td class="wrap">${escapeHtml(r.answers[f.id] || '')}</td>`).join('');
        if (writable) {
          const td = el('td', 'response-read-toggle');
          const btn = el('button', 'btn btn-sm', r.read_at ? 'Mark unread' : 'Mark read');
          btn.addEventListener('click', () => toggleResponseRead(form, r, tr, btn));
          td.appendChild(btn);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      table.appendChild(thead);
      table.appendChild(tbody);
    } catch (e) {
      table.innerHTML = `<tbody><tr><td>${escapeHtml(e.message || 'Failed to load responses')}</td></tr></tbody>`;
    }

    exportBtn.addEventListener('click', () => {
      if (!window.XLSX) { alert('Export library did not load.'); return; }
      const rows = responseRows.map((r) => {
        const row = { Submitted: r.submitted_at };
        responseFields.forEach((f) => { row[f.label] = r.answers[f.id] || ''; });
        return row;
      });
      const ws = window.XLSX.utils.json_to_sheet(rows);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Responses');
      window.XLSX.writeFile(wb, `${form.slug}-responses.xlsx`);
    });

    return wrap;
  }

  // -- Detail panel orchestration --------------------------------------

  async function renderDetail() {
    const myToken = ++renderToken;
    const form = forms.find((f) => f.id === activeFormId);
    if (!form) { detailEl.innerHTML = '<p class="empty-msg">Select or create a form.</p>'; return; }

    const writable = canWrite();
    // Both fetches kick off in parallel — each builds its section
    // detached from the live DOM, so neither one touches detailEl until
    // both are ready and we've confirmed no newer selectForm() happened
    // in the meantime.
    const [fieldsSection, responsesSection] = await Promise.all([
      buildFieldBuilderSection(form, writable),
      buildResponsesSection(form, writable),
    ]);
    if (myToken !== renderToken) return; // a newer selectForm() ran while these were loading

    detailEl.innerHTML = '';
    renderSettingsSection(detailEl, form, writable);
    detailEl.appendChild(el('hr'));
    detailEl.appendChild(fieldsSection);
    detailEl.appendChild(el('hr'));
    detailEl.appendChild(responsesSection);
  }

  function init() {
    formsListEl = document.getElementById('forms-list');
    detailEl = document.getElementById('forms-detail');
    const newFormBtn = document.getElementById('new-form-btn');
    if (canWrite()) newFormBtn.addEventListener('click', createForm);
    else newFormBtn.style.display = 'none';
    loadForms();

    // Background poll so a new submission's unread badge shows up while
    // an admin is sitting on the page, not just on next full page load.
    // Only touches the forms list/badges (see refreshUnreadCounts) — never
    // the open form's detail view, so it can't disrupt in-progress edits.
    setInterval(refreshUnreadCounts, 90000);
  }

  return { init };
})();
