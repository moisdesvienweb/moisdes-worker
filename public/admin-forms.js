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
  let fields = []; // working copy for the field builder

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  function renderFormsList() {
    formsListEl.innerHTML = '';
    forms.forEach((f) => {
      const li = el('li', f.id === activeFormId ? 'active' : '');
      const status = f.settings?.status === 'closed' ? ' (closed)' : '';
      li.innerHTML = `<span>${escapeHtml(f.title || '(untitled)')}${status}</span>`;
      li.addEventListener('click', () => selectForm(f.id));
      formsListEl.appendChild(li);
    });
  }

  async function selectForm(id) {
    activeFormId = id;
    renderFormsList();
    await renderDetail();
  }

  async function createForm() {
    const { id } = await api.post('/api/forms', { title: 'New form', settings: {} });
    await loadForms();
    activeFormId = id;
    renderFormsList();
    await renderDetail();
  }

  async function renderDetail() {
    const form = forms.find((f) => f.id === activeFormId);
    if (!form) { detailEl.innerHTML = '<p class="empty-msg">Select or create a form.</p>'; return; }
    detailEl.innerHTML = '';

    const settings = form.settings || {};
    const publicUrl = `${location.origin}/form/${form.slug}`;

    // -- Settings --
    const settingsWrap = el('div');
    settingsWrap.appendChild(el('h2', '', 'Settings'));

    const titleInput = el('input');
    titleInput.type = 'text';
    titleInput.value = form.title || '';
    settingsWrap.appendChild(fieldGroup('Title', titleInput));

    const linkP = el('p', 'state-msg', `Public URL: <a href="${publicUrl}" target="_blank" rel="noopener">${publicUrl}</a>`);
    settingsWrap.appendChild(linkP);

    const descInput = el('textarea');
    descInput.value = settings.description || '';
    settingsWrap.appendChild(fieldGroup('Description (shown above the form)', descInput));

    const statusSelect = el('select');
    statusSelect.innerHTML = '<option value="open">Open</option><option value="closed">Closed</option>';
    statusSelect.value = settings.status === 'closed' ? 'closed' : 'open';
    settingsWrap.appendChild(fieldGroup('Status', statusSelect));

    const thankTitle = el('input');
    thankTitle.type = 'text';
    thankTitle.value = settings.thankYouTitle || '';
    thankTitle.placeholder = 'א דאנק!';
    settingsWrap.appendChild(fieldGroup('Thank-you title', thankTitle));

    const thankMsg = el('textarea');
    thankMsg.value = settings.thankYouMessage || '';
    thankMsg.placeholder = 'אייער ענטפער איז אנגענומען געווארן.';
    settingsWrap.appendChild(fieldGroup('Thank-you message', thankMsg));

    const saveSettingsBtn = el('button', 'btn btn-primary', 'Save settings');
    const settingsStatus = el('span', 'status-msg', '');
    settingsWrap.appendChild(saveSettingsBtn);
    settingsWrap.appendChild(settingsStatus);
    saveSettingsBtn.addEventListener('click', async () => {
      saveSettingsBtn.disabled = true;
      try {
        await api.put(`/api/forms/${form.id}`, {
          title: titleInput.value,
          settings: {
            description: descInput.value,
            status: statusSelect.value,
            thankYouTitle: thankTitle.value,
            thankYouMessage: thankMsg.value,
          },
        });
        settingsStatus.textContent = 'Saved.';
        settingsStatus.className = 'status-msg ok';
        await loadForms();
      } catch (e) {
        settingsStatus.textContent = e.message || 'Failed to save';
        settingsStatus.className = 'status-msg err';
      }
      saveSettingsBtn.disabled = false;
    });

    const deleteFormBtn = el('button', 'btn btn-danger', 'Delete form');
    deleteFormBtn.style.marginLeft = '.5rem';
    deleteFormBtn.addEventListener('click', async () => {
      if (!confirm('Delete this form and its responses?')) return;
      await api.del(`/api/forms/${form.id}`);
      activeFormId = null;
      await loadForms();
    });
    settingsWrap.appendChild(deleteFormBtn);

    detailEl.appendChild(settingsWrap);
    detailEl.appendChild(el('hr'));

    // -- Field builder --
    const builderWrap = el('div');
    builderWrap.appendChild(el('h2', '', 'Fields'));

    const palette = el('div', 'field-palette');
    FIELD_TYPES.forEach(([type, label]) => {
      const btn = el('button', 'palette-btn', `+ ${label}`);
      btn.type = 'button';
      btn.addEventListener('click', () => { fields.push({ type, label: label, placeholder: '', options: [], required: false }); renderFieldList(); });
      palette.appendChild(btn);
    });
    builderWrap.appendChild(palette);

    const fieldListEl = el('div');
    builderWrap.appendChild(fieldListEl);

    const saveFieldsBtn = el('button', 'btn btn-primary', 'Save fields');
    const fieldsStatus = el('span', 'status-msg', '');
    builderWrap.appendChild(saveFieldsBtn);
    builderWrap.appendChild(fieldsStatus);

    function renderFieldList() {
      fieldListEl.innerHTML = '';
      fields.forEach((f, i) => {
        const card = el('div', 'builder-field');
        const head = el('div', 'builder-field-head');
        head.appendChild(el('span', 'type-badge', f.type));
        head.appendChild(el('span', 'spacer'));
        const up = el('button', 'btn btn-sm', '&#9650;');
        up.type = 'button';
        up.addEventListener('click', () => { if (i > 0) { [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; renderFieldList(); } });
        const down = el('button', 'btn btn-sm', '&#9660;');
        down.type = 'button';
        down.addEventListener('click', () => { if (i < fields.length - 1) { [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; renderFieldList(); } });
        const rm = el('button', 'btn btn-sm btn-danger', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', () => { fields.splice(i, 1); renderFieldList(); });
        head.appendChild(up);
        head.appendChild(down);
        head.appendChild(rm);
        card.appendChild(head);

        const labelInput = el('input');
        labelInput.type = 'text';
        labelInput.value = f.label || '';
        labelInput.placeholder = NO_LABEL_FIELD.has(f.type) ? 'Text to display' : 'Field label';
        labelInput.addEventListener('input', () => { f.label = labelInput.value; });
        card.appendChild(fieldGroup('Label', labelInput));

        if (HAS_PLACEHOLDER.has(f.type)) {
          const ph = el('input');
          ph.type = 'text';
          ph.value = f.placeholder || '';
          ph.addEventListener('input', () => { f.placeholder = ph.value; });
          card.appendChild(fieldGroup('Placeholder', ph));
        }

        if (HAS_OPTIONS.has(f.type)) {
          const opts = el('input');
          opts.type = 'text';
          opts.value = (f.options || []).join(', ');
          opts.placeholder = 'Option 1, Option 2, Option 3';
          opts.addEventListener('input', () => { f.options = opts.value.split(',').map((s) => s.trim()).filter(Boolean); });
          card.appendChild(fieldGroup('Options (comma-separated)', opts));
        }

        if (!NO_LABEL_FIELD.has(f.type)) {
          const reqLabel = el('label');
          const reqInput = el('input');
          reqInput.type = 'checkbox';
          reqInput.checked = !!f.required;
          reqInput.style.width = 'auto';
          reqInput.addEventListener('change', () => { f.required = reqInput.checked; });
          reqLabel.appendChild(reqInput);
          reqLabel.appendChild(document.createTextNode(' Required'));
          card.appendChild(reqLabel);
        }

        fieldListEl.appendChild(card);
      });
    }

    try {
      const { fields: loaded } = await api.get(`/api/forms/${form.id}/fields`);
      fields = loaded.map((f) => ({ type: f.type, label: f.label, placeholder: f.placeholder, options: f.options || [], required: !!f.required }));
    } catch (e) {
      fields = [];
    }
    renderFieldList();

    saveFieldsBtn.addEventListener('click', async () => {
      saveFieldsBtn.disabled = true;
      try {
        await api.post(`/api/forms/${form.id}/fields`, { fields });
        fieldsStatus.textContent = 'Saved.';
        fieldsStatus.className = 'status-msg ok';
      } catch (e) {
        fieldsStatus.textContent = e.message || 'Failed to save';
        fieldsStatus.className = 'status-msg err';
      }
      saveFieldsBtn.disabled = false;
    });

    detailEl.appendChild(builderWrap);
    detailEl.appendChild(el('hr'));

    // -- Responses --
    const responsesWrap = el('div', 'response-table-wrap');
    responsesWrap.appendChild(el('h2', '', 'Responses'));
    const exportBtn = el('button', 'btn', 'Export XLSX');
    responsesWrap.appendChild(exportBtn);
    const table = el('table');
    const tableWrap = el('div', 'table-wrap');
    tableWrap.appendChild(table);
    responsesWrap.appendChild(tableWrap);
    detailEl.appendChild(responsesWrap);

    let responseFields = [], responseRows = [];
    try {
      const data = await api.get(`/api/forms/${form.id}/responses`);
      responseFields = data.fields;
      responseRows = data.responses;
      table.innerHTML = `<thead><tr><th>Submitted</th>${responseFields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('')}</tr></thead>` +
        `<tbody>${responseRows.map((r) => `<tr><td>${escapeHtml(r.submitted_at)}</td>${responseFields.map((f) => `<td class="wrap">${escapeHtml(r.answers[f.id] || '')}</td>`).join('')}</tr>`).join('') ||
          `<tr><td colspan="${responseFields.length + 1}">No responses yet.</td></tr>`}</tbody>`;
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
  }

  function fieldGroup(labelText, inputEl) {
    const g = el('div', 'field-group');
    g.appendChild(el('label', '', labelText));
    g.appendChild(inputEl);
    return g;
  }

  function init() {
    formsListEl = document.getElementById('forms-list');
    detailEl = document.getElementById('forms-detail');
    document.getElementById('new-form-btn').addEventListener('click', createForm);
    loadForms();
  }

  return { init };
})();
