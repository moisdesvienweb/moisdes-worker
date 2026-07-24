// ================================================================
// MOISDES — SITE SEARCH
// search.js — client-side search across all content types.
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const resultsEl = document.getElementById('search-results');
  const input = document.getElementById('search-input');
  const form = document.getElementById('search-form');

  const params = new URLSearchParams(location.search);
  const q = (params.get('q') || '').trim();
  input.value = q;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    location.href = v ? `/search/?q=${encodeURIComponent(v)}` : '/search/';
  });

  if (!q) return;

  const SOURCES = [
    { type: 'posts', label: 'בלאג', page: '/blog', fields: ['title', 'body', 'tags', 'category'], excerptField: 'body' },
    { type: 'posters', label: 'מודעות', page: '/posters', fields: ['parsha'], excerptField: null },
    { type: 'events', label: 'מעמדים', page: '/events', fields: ['title', 'description', 'tags', 'category', 'location'], excerptField: 'description' },
    { type: 'videos', label: 'ווידיאוס', page: '/video', fields: ['title', 'description', 'tags', 'category', 'location'], excerptField: 'description' },
    { type: 'pdfs', label: 'גליונות', page: '/pdfs', fields: ['title', 'category', 'language', 'parsha', 'year'], excerptField: null },
  ];

  function stripHtml(html) {
    return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function excerpt(text, len) {
    text = stripHtml(text);
    return text.length > len ? text.slice(0, len) + '…' : text;
  }
  function matches(item, fields) {
    const needle = q.toLowerCase();
    return fields.some((f) => stripHtml(item[f]).toLowerCase().includes(needle));
  }
  function titleFor(source, item) {
    if (item.title) return item.title;
    if (source.type === 'posters') return `מודעה — ${item.parsha || ''}`;
    if (source.type === 'pdfs') return item.title || 'גליון';
    return '';
  }

  resultsEl.innerHTML = '<p class="state-msg">זוכט...</p>';

  try {
    const responses = await Promise.all(SOURCES.map((s) => api.get(`/api/${s.type}`).catch(() => ({ [s.type]: [] }))));
    let totalResults = 0;
    resultsEl.innerHTML = '';

    SOURCES.forEach((source, i) => {
      const items = responses[i][source.type] || [];
      const found = items.filter((item) => matches(item, source.fields));
      if (!found.length) return;
      totalResults += found.length;

      resultsEl.appendChild(Object.assign(document.createElement('h2'), { className: 'search-group-heading', textContent: source.label }));
      found.slice(0, 20).forEach((item) => {
        const row = document.createElement('a');
        row.className = 'search-result';
        row.style.display = 'block';
        row.href = `${source.page}#${source.type.slice(0, -1)}-${item.id}`;
        const meta = item.date ? hebrew.isoToHebrewString(item.date) : '';
        row.innerHTML = `
          <div class="search-result-title">${util.eh(titleFor(source, item))}</div>
          ${meta ? `<div class="search-result-meta">${meta}</div>` : ''}
          ${source.excerptField ? `<div class="search-result-excerpt">${util.eh(excerpt(item[source.excerptField], 140))}</div>` : ''}
        `;
        resultsEl.appendChild(row);
      });
    });

    if (!totalResults) {
      resultsEl.innerHTML = `<p class="state-msg">קיין רעזולטאטן נישט געפונען פאר "${util.eh(q)}"</p>`;
    }
  } catch (e) {
    resultsEl.innerHTML = '<p class="state-msg">נישט געקענט זוכן</p>';
  }
})();
