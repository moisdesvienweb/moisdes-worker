// ================================================================
// MOISDES — VIDEO PAGE
// video.js
// ================================================================

(function () {
  window.MOISDES.util.youtubeId = function (url) {
    if (!url) return null;
    const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  };
})();

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const grid = document.getElementById('video-grid');
  const bannerEl = document.getElementById('tag-filter-banner');

  const params = new URLSearchParams(location.search);
  const activeTag = params.get('tag');

  function tagPill(tag) {
    const a = document.createElement('a');
    a.className = 'tag-pill';
    a.textContent = tag;
    a.href = `/video?tag=${encodeURIComponent(tag)}`;
    return a;
  }

  if (activeTag) {
    bannerEl.innerHTML = `<div class="tag-filter-banner">מציג רעזולטאטן פארן טאג: <strong>${util.eh(activeTag)}</strong> · <a href="/video">מעק אויס</a></div>`;
  }

  try {
    const { videos } = await api.get('/api/videos');
    const filtered = activeTag
      ? videos.filter((v) => (v.tags || '').split(',').map((t) => t.trim()).includes(activeTag))
      : videos;

    if (!filtered.length) {
      grid.innerHTML = '<p class="state-msg">נאך קיין ווידיאוס נישט פארעפנטליכט</p>';
      return;
    }
    const sorted = [...filtered].sort((a, b) => util.dateDesc(a.date, b.date));
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = '1fr';

    for (const v of sorted) {
      const ytId = util.youtubeId(v.video_url);
      const card = document.createElement('div');
      card.className = 'card';
      card.id = `video-${v.id}`;
      card.style.padding = '1.25rem 1.4rem';
      card.innerHTML = `
        ${ytId ? `<div class="video-embed"><iframe src="https://www.youtube.com/embed/${ytId}" allowfullscreen loading="lazy"></iframe></div>` : ''}
        <div class="event-meta">${hebrew.isoToHebrewString(v.date)}${v.location ? ' · ' + util.eh(v.location) : ''}${v.category ? ' · ' + util.eh(v.category) : ''}</div>
        <h2 class="video-title">${util.eh(v.title)}</h2>
        <div class="event-desc">${util.eh(v.description || '')}</div>
        <div class="event-tags"></div>
      `;
      const tagsEl = card.querySelector('.event-tags');
      (v.tags || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => tagsEl.appendChild(tagPill(t)));
      if (!tagsEl.children.length) tagsEl.remove();
      grid.appendChild(card);
    }

    if (location.hash) {
      const target = document.querySelector(location.hash);
      if (target) target.scrollIntoView();
    }
  } catch (e) {
    grid.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
