// ================================================================
// MOISDES ADMIN — Browse & Edit panel
// admin-browse.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminBrowse = (function () {
  const api = window.MOISDES.api;
  const hebrew = window.MOISDES.hebrew;
  const upload = window.MOISDES.adminUpload;

  const COLUMNS = {
    posts: [['date', 'Date'], ['title', 'Title'], ['category', 'Category'], ['tags', 'Tags']],
    posters: [['date', 'Date'], ['parsha', 'Parsha']],
    events: [['date', 'Date'], ['title', 'Title'], ['location', 'Location'], ['category', 'Category']],
    videos: [['date', 'Date'], ['title', 'Title'], ['location', 'Location'], ['category', 'Category']],
    pdfs: [['date', 'Date'], ['title', 'Title'], ['category', 'Category'], ['language', 'Language'], ['parsha', 'Parsha'], ['year', 'Year']],
    simchas: [['date_added', 'Date added'], ['text', 'Text']],
  };

  let currentType = 'posts';
  let currentRows = [];
  let table, thead, tbody, filterInput;
  let modalOverlay, modalTitle, modalBody, modalClose;

  // Public-site URL for a row, matching home.js's TYPE_META hrefs.
  // Simchas have no page of their own (ticker-only, no per-item link) —
  // deliberately left out, so no Live view button renders for that type.
  const PUBLIC_URL = {
    posts: (row) => `/blog/post.html?id=${row.id}`,
    posters: (row) => `/posters#poster-${row.id}`,
    events: (row) => `/events/post.html?id=${row.id}`,
    videos: (row) => `/video/post.html?id=${row.id}`,
    pdfs: (row) => `/pdfs#pdf-${row.id}`,
  };

  // Every type that can be featured/scheduled — matches the Worker's
  // SCHEDULABLE_TYPES (everything except simchas).
  const FEATURABLE_TYPES = new Set(['posts', 'posters', 'events', 'videos', 'pdfs']);

  function fmtDate(iso) {
    if (!iso) return '';
    try { return hebrew.isoToHebrewString(iso); } catch (e) { return iso; }
  }

  // publish_at is stored "YYYY-MM-DD HH:MM:SS" UTC (no 'Z') — same
  // "append Z if missing" convention used throughout this codebase for
  // that column shape.
  function publishAtDate(row) {
    if (!row.publish_at) return null;
    const d = new Date(row.publish_at.includes('T') ? row.publish_at : row.publish_at.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  function isScheduled(row) {
    const d = publishAtDate(row);
    return !!d && d.getTime() > Date.now();
  }
  function fmtScheduled(row) {
    const d = publishAtDate(row);
    return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  // Matches home.js's titleFor — a label for a row whose type doesn't
  // have its own "title" field.
  function labelFor(type, row) {
    if (type === 'posters') return row.parsha ? `Poster — ${row.parsha}` : 'Poster';
    return row.title || '';
  }

  // Admin/superadmin always have full access; an 'editor' is gated by
  // whatever was granted for this section in the Users panel. This only
  // controls what's shown here — the Worker enforces the real boundary.
  function canWrite(type) {
    const role = api.getUser()?.role;
    if (role === 'admin' || role === 'superadmin') return true;
    return !!api.getPermissions()?.[type]?.write;
  }

  function render() {
    if (currentType === 'featured') { renderFeaturedTab(); return; }

    const cols = COLUMNS[currentType];
    // "Uploaded by" isn't a real content field — it's admin-only
    // attribution the Worker attaches server-side (only for an
    // authenticated request with read access), so it's appended here
    // rather than listed per-type in COLUMNS above.
    thead.innerHTML = `<tr>${cols.map(([, label]) => `<th>${label}</th>`).join('')}<th>Uploaded by</th><th>Actions</th></tr>`;

    const q = (filterInput.value || '').toLowerCase().trim();
    const writable = canWrite(currentType);
    tbody.innerHTML = '';
    currentRows
      .filter((row) => !q || cols.some(([key]) => String(row[key] || '').toLowerCase().includes(q)))
      .forEach((row) => {
        const tr = document.createElement('tr');
        tr.innerHTML = cols.map(([key]) => {
          const cell = key === 'date' ? fmtDate(row[key]) : escapeHtml(row[key] || '');
          const sched = key === 'date' && isScheduled(row)
            ? `<br><span class="state-msg">Scheduled: ${escapeHtml(fmtScheduled(row))}</span>` : '';
          return `<td class="wrap">${cell}${sched}</td>`;
        }).join('') + `<td class="wrap">${escapeHtml(row.uploaded_by_name || '—')}</td>`;
        const actionsTd = document.createElement('td');
        const publicUrlFn = PUBLIC_URL[currentType];
        if (publicUrlFn) {
          const liveBtn = document.createElement('a');
          liveBtn.className = 'btn btn-sm';
          liveBtn.textContent = 'Live view';
          liveBtn.href = publicUrlFn(row);
          liveBtn.target = '_blank';
          liveBtn.rel = 'noopener';
          liveBtn.style.marginInlineEnd = '.4rem';
          actionsTd.appendChild(liveBtn);
        }
        if (writable) {
          if (FEATURABLE_TYPES.has(currentType)) {
            const featBtn = document.createElement('button');
            featBtn.type = 'button';
            featBtn.className = 'btn btn-sm' + (Number(row.featured) ? ' btn-primary' : '');
            featBtn.textContent = Number(row.featured) ? '★ Featured' : '☆ Feature';
            featBtn.style.marginInlineEnd = '.4rem';
            featBtn.addEventListener('click', () => toggleFeatured(currentType, row, featBtn));
            actionsTd.appendChild(featBtn);
          }
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'btn btn-sm';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', () => openEdit(row));
          const dupBtn = document.createElement('button');
          dupBtn.type = 'button';
          dupBtn.className = 'btn btn-sm';
          dupBtn.textContent = 'Duplicate';
          dupBtn.addEventListener('click', () => openDuplicate(row));
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'btn btn-sm btn-danger';
          delBtn.textContent = 'Delete';
          delBtn.addEventListener('click', () => remove(row));
          actionsTd.appendChild(editBtn);
          actionsTd.appendChild(dupBtn);
          actionsTd.appendChild(delBtn);
        } else if (!publicUrlFn) {
          actionsTd.className = 'state-msg';
          actionsTd.textContent = 'View only';
        }
        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
      });
  }

  // Combined view across every featurable type at once — currentRows is
  // already the flattened, pre-tagged (row._type) list built by load().
  function renderFeaturedTab() {
    thead.innerHTML = '<tr><th>Type</th><th>Date</th><th>Title</th><th>Uploaded by</th><th>Actions</th></tr>';
    const q = (filterInput.value || '').toLowerCase().trim();
    tbody.innerHTML = '';
    const filtered = currentRows.filter((row) => !q ||
      row._type.includes(q) || labelFor(row._type, row).toLowerCase().includes(q));
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="5">${currentRows.length ? 'No results.' : 'Nothing is featured yet — star an item in its own Browse tab, or from its upload/edit form.'}</td></tr>`;
      return;
    }
    filtered.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="wrap">${escapeHtml(row._type)}</td>
        <td class="wrap">${fmtDate(row.date)}${isScheduled(row) ? `<br><span class="state-msg">Scheduled: ${escapeHtml(fmtScheduled(row))}</span>` : ''}</td>
        <td class="wrap">${escapeHtml(labelFor(row._type, row))}</td>
        <td class="wrap">${escapeHtml(row.uploaded_by_name || '—')}</td>`;
      const actionsTd = document.createElement('td');
      const publicUrlFn = PUBLIC_URL[row._type];
      if (publicUrlFn) {
        const liveBtn = document.createElement('a');
        liveBtn.className = 'btn btn-sm';
        liveBtn.textContent = 'Live view';
        liveBtn.href = publicUrlFn(row);
        liveBtn.target = '_blank';
        liveBtn.rel = 'noopener';
        liveBtn.style.marginInlineEnd = '.4rem';
        actionsTd.appendChild(liveBtn);
      }
      if (canWrite(row._type)) {
        const unfeatBtn = document.createElement('button');
        unfeatBtn.type = 'button';
        unfeatBtn.className = 'btn btn-sm btn-danger';
        unfeatBtn.textContent = 'Un-feature';
        unfeatBtn.addEventListener('click', async () => {
          unfeatBtn.disabled = true;
          try {
            await api.put(`/api/${row._type}/${row.id}`, { ...row, featured: 0 });
            currentRows = currentRows.filter((r) => r !== row);
            render();
          } catch (e) {
            alert(e.message || 'Could not update.');
            unfeatBtn.disabled = false;
          }
        });
        actionsTd.appendChild(unfeatBtn);
      }
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function load(type) {
    currentType = type;
    tbody.innerHTML = '<tr><td>Loading…</td></tr>';
    try {
      if (type === 'featured') {
        const types = [...FEATURABLE_TYPES];
        const results = await Promise.all(types.map((t) => api.get(`/api/${t}`).catch(() => ({ [t]: [] }))));
        currentRows = types.flatMap((t, i) => (results[i][t] || [])
          .filter((r) => Number(r.featured))
          .map((r) => ({ ...r, _type: t })));
        currentRows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      } else {
        const data = await api.get(`/api/${type}`);
        currentRows = data[type] || [];
      }
      render();
    } catch (e) {
      tbody.innerHTML = `<tr><td>${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
    }
  }

  function openEdit(row) {
    modalTitle.textContent = `Edit ${currentType.slice(0, 1).toUpperCase() + currentType.slice(1)}`;
    upload.buildForm(currentType, modalBody, {
      existing: row,
      onSaved: () => { closeModal(); load(currentType); },
    });
    modalOverlay.classList.add('open');
  }

  // Opens a fresh Publish form pre-filled with this row's text/metadata
  // (title, description, tags, etc.) but no files — edit anything, then
  // Publish creates a brand new item, leaving the original untouched.
  function openDuplicate(row) {
    modalTitle.textContent = `Duplicate ${currentType.slice(0, 1).toUpperCase() + currentType.slice(1)}`;
    upload.buildForm(currentType, modalBody, {
      prefill: row,
      onSaved: () => { closeModal(); load(currentType); },
    });
    modalOverlay.classList.add('open');
  }
  function closeModal() {
    modalOverlay.classList.remove('open');
    modalBody.innerHTML = '';
  }

  async function toggleFeatured(type, row, btn) {
    const next = Number(row.featured) ? 0 : 1;
    btn.disabled = true;
    try {
      await api.put(`/api/${type}/${row.id}`, { ...row, featured: next });
      row.featured = next;
      render();
    } catch (e) {
      alert(e.message || 'Could not update.');
      btn.disabled = false;
    }
  }

  async function remove(row) {
    if (!confirm('Delete this item? This cannot be undone from the site.')) return;
    try {
      await api.del(`/api/${currentType}/${row.id}`);
      currentRows = currentRows.filter((r) => r.id !== row.id);
      render();
    } catch (e) {
      alert(e.message || 'Delete failed');
    }
  }

  function init() {
    table = document.getElementById('browse-table');
    thead = table.querySelector('thead');
    tbody = table.querySelector('tbody');
    filterInput = document.getElementById('browse-filter');
    modalOverlay = document.getElementById('edit-modal-overlay');
    modalTitle = document.getElementById('edit-modal-title');
    modalBody = document.getElementById('edit-modal-body');
    modalClose = document.getElementById('edit-modal-close');

    filterInput.addEventListener('input', render);
    modalClose.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

    document.querySelectorAll('#browse-subtabs .subtab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#browse-subtabs .subtab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        filterInput.value = '';
        load(btn.dataset.type);
      });
    });

    load('posts');
  }

  return { init, reload: () => load(currentType) };
})();
