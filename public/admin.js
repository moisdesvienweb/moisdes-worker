// ================================================================
// MOISDES ADMIN — top-level wiring
// admin.js
// ================================================================

(function () {
  const api = window.MOISDES.api;

  if (!api.isLoggedIn()) {
    location.href = '/login.html?redirect=' + encodeURIComponent(location.pathname);
    return;
  }

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
  loadUploadTab('posts');

  // ── Init other panels ─────────────────────────────────────────────
  window.MOISDES.adminBrowse.init();
  window.MOISDES.adminForms.init();
  window.MOISDES.adminUsers.init();
})();
