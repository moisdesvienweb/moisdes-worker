// ================================================================
// MOISDES — EVENTS PAGE
// events.js — compact cards in the grid; each links to its own detail
// page (/events/post.html?id=) instead of opening a popup, so every
// event (and its audio playlist) has a real, shareable URL.
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const list = document.getElementById('events-list');
  const bannerEl = document.getElementById('tag-filter-banner');

  const params = new URLSearchParams(location.search);
  const activeTag = params.get('tag');

  function excerpt(html, len) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > len ? text.slice(0, len) + '…' : text;
  }

  // Old-style "#event-<id>" links (from before events got their own
  // pages) redirect straight to the new detail URL instead of landing on
  // a dead anchor.
  if (location.hash && /^#event-\d+$/.test(location.hash)) {
    location.replace(`/events/post.html?id=${location.hash.slice(7)}`);
    return;
  }

  if (activeTag) {
    bannerEl.innerHTML = `<div class="tag-filter-banner">מציג רעזולטאטן פארן טאג: <strong>${util.eh(activeTag)}</strong> · <a href="/events">מעק אויס</a></div>`;
  }

  try {
    const { events } = await api.get('/api/events');
    const filtered = activeTag
      ? events.filter((e) => (e.tags || '').split(',').map((t) => t.trim()).includes(activeTag))
      : events;

    if (!filtered.length) {
      list.innerHTML = '<p class="state-msg">נאך קיין מעמדים נישט פארעפנטליכט</p>';
      return;
    }
    const sorted = [...filtered].sort((a, b) => util.dateDesc(a.date, b.date));
    list.innerHTML = '';

    for (const ev of sorted) {
      const coverUrl = ev.thumb_url ? api.r2Url(ev.thumb_url) : await api.firstImageUrl(ev.folder_url);

      const card = document.createElement('a');
      card.href = `/events/post.html?id=${ev.id}`;
      card.className = 'card';
      card.innerHTML = `
        <div class="card-media">${coverUrl ? `<img src="${util.eh(coverUrl)}" alt="">` : ''}</div>
        <div class="card-body">
          <div class="card-date">${hebrew.isoToHebrewString(ev.date)}${ev.location ? ' · ' + util.eh(ev.location) : ''}</div>
          <div class="card-title">${util.eh(ev.title)}</div>
          <p class="card-excerpt">${util.eh(excerpt(ev.description, 90))}</p>
        </div>`;
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
