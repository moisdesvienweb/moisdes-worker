// ================================================================
// MOISDES ADMIN — Analytics (page views + clicks/shares)
// admin-analytics.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminAnalytics = (function () {
  const api = window.MOISDES.api;

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  let loaded = false;
  async function load() {
    if (loaded) return;
    const totalsEl = document.getElementById('analytics-totals');
    const pathBody = document.querySelector('#analytics-path-table tbody');
    const labelBody = document.querySelector('#analytics-label-table tbody');
    try {
      const { totals, byPath, byLabel } = await api.get('/api/analytics/summary');
      totalsEl.innerHTML = totals.map((t) =>
        `<div class="analytics-stat"><div class="analytics-stat-num">${t.count}</div><div class="analytics-stat-label">${escapeHtml(t.kind)}</div></div>`
      ).join('') || '<p class="state-msg">No data yet.</p>';

      pathBody.innerHTML = byPath.map((r) =>
        `<tr><td>${escapeHtml(r.path)}</td><td>${escapeHtml(r.kind)}</td><td>${r.count}</td></tr>`
      ).join('') || '<tr><td colspan="3">No data yet.</td></tr>';

      labelBody.innerHTML = byLabel.map((r) =>
        `<tr><td class="wrap">${escapeHtml(r.label)}</td><td>${escapeHtml(r.kind)}</td><td>${r.count}</td></tr>`
      ).join('') || '<tr><td colspan="3">No data yet.</td></tr>';

      loaded = true;
    } catch (e) {
      totalsEl.innerHTML = `<p class="state-msg">${escapeHtml(e.message || 'Failed to load')}</p>`;
    }
  }

  function init() {
    const btn = document.querySelector('.sidebar-link[data-panel="analytics"]');
    if (btn) btn.addEventListener('click', load);
  }

  return { init };
})();
