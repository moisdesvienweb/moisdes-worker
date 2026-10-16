// ================================================================
// MOISDES ADMIN — top-level wiring
// admin.js
// ================================================================

(async function () {
  const api = window.MOISDES.api;

  if (!api.isLoggedIn()) {
    location.href = '/login.html?redirect=' + encodeURIComponent(location.pathname);
    return;
  }

  // Refresh permissions from the server before anything renders — the
  // cached copy in localStorage can be stale if an admin changed this
  // user's access since their last login. Every panel below reads
  // api.getPermissions()/api.getUser() at init time, so this must finish
  // first. Falls back to the cached copy if the request fails (e.g. a
  // brief network hiccup) rather than locking the user out of everything.
  try {
    const me = await api.get('/api/me');
    api.setPermissions(me.permissions);
  } catch (e) { /* use cached permissions */ }
  const permissions = api.getPermissions() || {};
  const role = api.getUser()?.role;
  const isFullAccess = role === 'admin' || role === 'superadmin';

  // ── Sidebar panel switching ──────────────────────────────────────
  document.querySelectorAll('.sidebar-link[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-link[data-panel]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
    });
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api.logout();
    location.href = '/login.html';
  });

  // ── Upload sub-tabs ───────────────────────────────────────────────
  const uploadContainer = document.getElementById('upload-form-container');
  function loadUploadTab(type) {
    window.MOISDES.adminUpload.buildForm(type, uploadContainer);
  }
  document.querySelectorAll('#upload-subtabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#upload-subtabs .subtab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadUploadTab(btn.dataset.type);
    });
  });

  // ── Init other panels ─────────────────────────────────────────────
  window.MOISDES.adminBrowse.init();
  window.MOISDES.adminForms.init();
  window.MOISDES.adminUsers.init();
  if (window.MOISDES.adminDaf) window.MOISDES.adminDaf.init();
  if (window.MOISDES.adminSettings) window.MOISDES.adminSettings.init();
  if (window.MOISDES.adminAnalytics) window.MOISDES.adminAnalytics.init();

  // ── Apply per-section permissions to the nav ──────────────────────
  // Upload needs write; Browse only needs read (view-only browsing is
  // allowed with read alone — admin-browse.js hides Edit/Duplicate/Delete
  // itself). Content-type subtabs hide individually; a sidebar link whose
  // every subtab is hidden (or whose single section has no access) hides too.
  // Clear whatever the static HTML marked active by default — the block
  // below picks the first section this specific user actually has access
  // to, which won't always be "Upload" / "Blog (posts)".
  document.querySelectorAll('.sidebar-link.active, .subtab.active, .panel.active').forEach((el) => el.classList.remove('active'));

  let firstUploadType = null, firstBrowseType = null;
  document.querySelectorAll('#upload-subtabs .subtab').forEach((btn) => {
    const ok = isFullAccess || !!permissions[btn.dataset.type]?.write;
    btn.style.display = ok ? '' : 'none';
    if (ok && !firstUploadType) firstUploadType = btn.dataset.type;
  });
  document.querySelectorAll('#browse-subtabs .subtab').forEach((btn) => {
    const ok = isFullAccess || !!permissions[btn.dataset.type]?.read;
    btn.style.display = ok ? '' : 'none';
    if (ok && !firstBrowseType) firstBrowseType = btn.dataset.type;
  });

  const panelVisible = {
    upload: !!firstUploadType,
    browse: !!firstBrowseType,
    forms: isFullAccess || !!permissions.forms?.read,
    daf: isFullAccess || !!permissions.daf?.read,
    settings: isFullAccess || !!permissions.settings?.read,
    analytics: true, // aggregate stats only — not section-scoped
    users: isFullAccess, // account management is never delegable
  };
  let firstVisiblePanel = null;
  document.querySelectorAll('.sidebar-link[data-panel]').forEach((btn) => {
    const visible = panelVisible[btn.dataset.panel] !== false;
    btn.style.display = visible ? '' : 'none';
    if (visible && !firstVisiblePanel) firstVisiblePanel = btn.dataset.panel;
  });

  if (firstUploadType) {
    const btn = document.querySelector(`#upload-subtabs .subtab[data-type="${firstUploadType}"]`);
    btn.classList.add('active');
    loadUploadTab(firstUploadType);
  }
  if (firstBrowseType && firstBrowseType !== 'posts') {
    // admin-browse.js's own init() already loaded 'posts' by default —
    // re-point it at whichever type this user can actually read.
    document.querySelector(`#browse-subtabs .subtab[data-type="${firstBrowseType}"]`).click();
  } else if (firstBrowseType === 'posts') {
    document.querySelector('#browse-subtabs .subtab[data-type="posts"]').classList.add('active');
  }
  if (firstVisiblePanel) {
    document.querySelector(`.sidebar-link[data-panel="${firstVisiblePanel}"]`).classList.add('active');
    document.getElementById('panel-' + firstVisiblePanel).classList.add('active');
  } else {
    document.querySelector('.admin-main').innerHTML =
      '<p class="state-msg" style="padding:2rem">You don\'t have access to any admin section yet — ask an admin to grant permissions.</p>';
  }

  // ── Browse export-XLSX button (follows the active Browse subtab) ──
  const exportBtn = document.getElementById('browse-export-xlsx');
  let exportType = firstBrowseType || 'posts';
  document.querySelectorAll('#browse-subtabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => { exportType = btn.dataset.type; });
  });
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      if (!window.XLSX) { alert('Export library did not load.'); return; }
      exportBtn.disabled = true;
      try {
        const data = await api.get(`/api/${exportType}`);
        const rows = data[exportType] || [];
        const ws = window.XLSX.utils.json_to_sheet(rows);
        const wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, exportType);
        window.XLSX.writeFile(wb, `${exportType}.xlsx`);
      } catch (e) {
        alert(e.message || 'Export failed.');
      }
      exportBtn.disabled = false;
    });
  }
})();
