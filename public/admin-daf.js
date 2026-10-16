// ================================================================
// MOISDES ADMIN — Daf Calendar (ובהם נהגה) Excel upload
// admin-daf.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminDaf = (function () {
  const api = window.MOISDES.api;

  let fileInput, msgEl, tbody;

  function setMsg(text, ok) {
    msgEl.textContent = text;
    msgEl.className = 'state-msg' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  // Accepts any reasonable column naming (date/Date, text/Text/עמוד) and
  // any cell value XLSX/SheetJS hands back (string, Excel serial date, ...).
  function normalizeRow(row) {
    const dateKey = Object.keys(row).find((k) => /date/i.test(k)) || Object.keys(row)[0];
    const textKey = Object.keys(row).find((k) => k !== dateKey);
    let raw = row[dateKey];
    let iso;
    if (raw instanceof Date) {
      iso = raw.toISOString().slice(0, 10);
    } else if (typeof raw === 'number') {
      // Excel serial date (days since 1899-12-30)
      iso = new Date(Date.UTC(1899, 11, 30) + raw * 86400000).toISOString().slice(0, 10);
    } else {
      iso = String(raw || '').trim().slice(0, 10);
    }
    return { date: iso, text: String(row[textKey] || '').trim() };
  }

  async function loadTable() {
    tbody.innerHTML = '<tr><td colspan="2">Loading…</td></tr>';
    try {
      const { entries } = await api.get('/api/daf-entries');
      tbody.innerHTML = '';
      entries.slice().reverse().forEach((e) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${e.date}</td><td class="wrap">${String(e.text || '').replace(/</g, '&lt;')}</td>`;
        tbody.appendChild(tr);
      });
      if (!entries.length) tbody.innerHTML = '<tr><td colspan="2">No entries yet.</td></tr>';
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="2">${e.message || 'Failed to load'}</td></tr>`;
    }
  }

  async function handleFile(file) {
    if (!window.XLSX) { setMsg('Excel library unavailable — reload the page and try again.', false); return; }
    setMsg('Reading file…');
    try {
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const entries = rows.map(normalizeRow).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date));
      if (!entries.length) throw new Error('No valid rows found (expected a date column and a text column).');

      setMsg(`Uploading ${entries.length} entries…`);
      await api.post('/api/daf-entries/bulk', { entries });
      setMsg(`Saved ${entries.length} entries.`, true);
      loadTable();
    } catch (e) {
      setMsg(e.message || 'Upload failed', false);
    }
  }

  function canWrite() {
    const role = api.getUser()?.role;
    if (role === 'admin' || role === 'superadmin') return true;
    return !!api.getPermissions()?.daf?.write;
  }

  function init() {
    fileInput = document.getElementById('daf-file-input');
    msgEl = document.getElementById('daf-upload-msg');
    tbody = document.querySelector('#daf-table tbody');
    if (!fileInput) return;

    if (canWrite()) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) handleFile(file);
        fileInput.value = '';
      });
    } else {
      fileInput.style.display = 'none';
      setMsg("View only — you don't have write access to the Daf Calendar.");
    }
    loadTable();
  }

  return { init };
})();
