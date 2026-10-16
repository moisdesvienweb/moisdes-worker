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

  // Buckets a tracked path (location.pathname — "/blog/post.html",
  // "/events/post.html", "/pdfs/", "/", etc; see chrome.js's track())
  // into the content type it belongs to, for the "views by content type"
  // chart. Order matters: more specific prefixes are checked first.
  const CONTENT_TYPE_BUCKETS = [
    ['/blog/', 'Blog'], ['/events/', 'Events'], ['/video/', 'Videos'],
    ['/pdfs/', 'PDFs'], ['/posters/', 'Posters'], ['/calendar/', 'Calendar'],
    ['/search/', 'Search'],
  ];
  function bucketForPath(path) {
    if (path === '/' || path === '/index.html') return 'Home';
    for (const [prefix, label] of CONTENT_TYPE_BUCKETS) {
      if (path.startsWith(prefix)) return label;
    }
    return 'Other';
  }

  const CHART_COLORS = ['#d9a55c', '#6ba3d9', '#7fd88f', '#e26a5f', '#c89cd9', '#5ec9c9', '#e0b84d', '#9aa5b1'];

  let contentChart = null, kindChart = null;
  function renderPie(canvasId, labels, data, existing) {
    if (existing) existing.destroy();
    const ctx = document.getElementById(canvasId);
    if (!window.Chart || !ctx) return null;
    return new window.Chart(ctx, {
      type: 'pie',
      data: {
        labels,
        datasets: [{ data, backgroundColor: CHART_COLORS, borderColor: '#242426', borderWidth: 1 }],
      },
      options: {
        plugins: { legend: { position: 'right', labels: { color: '#f2f2f2', boxWidth: 12 } } },
      },
    });
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

      // Views by content type — bucket byPath's "view" rows by prefix.
      const byBucket = {};
      byPath.filter((r) => r.kind === 'view').forEach((r) => {
        const bucket = bucketForPath(r.path);
        byBucket[bucket] = (byBucket[bucket] || 0) + r.count;
      });
      const bucketEntries = Object.entries(byBucket).sort((a, b) => b[1] - a[1]);
      contentChart = renderPie('analytics-chart-content', bucketEntries.map((e) => e[0]), bucketEntries.map((e) => e[1]), contentChart);

      // Views vs. shares — straight from totals.
      kindChart = renderPie('analytics-chart-kind', totals.map((t) => t.kind), totals.map((t) => t.count), kindChart);

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

