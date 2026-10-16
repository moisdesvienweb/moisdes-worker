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
    a.href = `/search/?tag=${encodeURIComponent(tag)}`;
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
    grid.classList.add('video-grid');

    for (const v of sorted) {
      const ytId = util.youtubeId(v.video_url);
      // Listing page never embeds a player (no YouTube branding here at
      // all) — just a thumbnail with a play badge, linking to the
      // detail page where the actual video (with whatever branding it
      // carries) plays.
      let thumbUrl = null;
      if (ytId) thumbUrl = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
      else if (v.folder_url) thumbUrl = await api.firstImageUrl(v.folder_url);

      const card = document.createElement('a');
      card.className = 'card video-card-item';
      card.id = `video-${v.id}`;
      card.href = `/video/post.html?id=${v.id}`;
      card.innerHTML = `
        <div class="card-media video-thumb">
          ${thumbUrl ? `<img src="${util.eh(thumbUrl)}" alt="">` : ''}
          <span class="video-play-badge">&#9658;</span>
        </div>
        <div class="card-body">
          <div class="card-date">${hebrew.isoToHebrewString(v.date)}${v.location ? ' · ' + util.eh(v.location) : ''}${v.category ? ' · ' + util.eh(v.category) : ''}</div>
          <div class="card-title">${util.eh(v.title)}</div>
        </div>
      `;
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
