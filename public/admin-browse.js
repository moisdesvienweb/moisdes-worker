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
  };

  let currentType = 'posts';
  let currentRows = [];
  let table, thead, tbody, filterInput;
  let modalOverlay, modalTitle, modalBody, modalClose;

  function fmtDate(iso) {
    if (!iso) return '';
    try { return hebrew.isoToHebrewString(iso); } catch (e) { return iso; }
  }

  function render() {
    const cols = COLUMNS[currentType];
    thead.innerHTML = `<tr>${cols.map(([, label]) => `<th>${label}</th>`).join('')}<th>Actions</th></tr>`;

    const q = (filterInput.value || '').toLowerCase().trim();
    tbody.innerHTML = '';
    currentRows
      .filter((row) => !q || cols.some(([key]) => String(row[key] || '').toLowerCase().includes(q)))
      .forEach((row) => {
        const tr = document.createElement('tr');
        tr.innerHTML = cols.map(([key]) => `<td class="wrap">${key === 'date' ? fmtDate(row[key]) : escapeHtml(row[key] || '')}</td>`).join('');
        const actionsTd = document.createElement('td');
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-sm';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openEdit(row));
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => remove(row));
        actionsTd.appendChild(editBtn);
        actionsTd.appendChild(delBtn);
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
      const data = await api.get(`/api/${type}`);
      currentRows = data[type] || [];
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
  function closeModal() {
    modalOverlay.classList.remove('open');
    modalBody.innerHTML = '';
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
