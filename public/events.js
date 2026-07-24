// ================================================================
// MOISDES — EVENTS PAGE
// events.js
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const list = document.getElementById('events-list');
  const bannerEl = document.getElementById('tag-filter-banner');

  const params = new URLSearchParams(location.search);
  const activeTag = params.get('tag');

  const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a'];
  function isAudio(key) { return AUDIO_EXT.includes(key.split('.').pop().toLowerCase()); }

  function tagPill(tag) {
    const a = document.createElement('a');
    a.className = 'tag-pill';
    a.textContent = tag;
    a.href = `/events?tag=${encodeURIComponent(tag)}`;
    return a;
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
      const keys = await api.listFolder(ev.folder_url).catch(() => []);
      const audioKeys = keys.filter(isAudio);
      const imageKeys = keys.filter((k) => !isAudio(k));

      const card = document.createElement('article');
      card.className = 'event-card';
      card.id = `event-${ev.id}`;
      card.innerHTML = `
        <div class="event-meta">${hebrew.isoToHebrewString(ev.date)}${ev.location ? ' · ' + util.eh(ev.location) : ''}${ev.category ? ' · ' + util.eh(ev.category) : ''}</div>
        <h2 class="event-title">${util.eh(ev.title)}</h2>
        <div class="event-desc">${util.eh(ev.description || '')}</div>
      `;

      for (const key of audioKeys) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = api.r2Url(key);
        card.appendChild(audio);
      }

      if (imageKeys.length) {
        const stack = document.createElement('div');
        stack.className = 'stack';
        stack.style.marginTop = '1rem';
        imageKeys.forEach((key) => {
          const img = document.createElement('img');
          img.src = api.r2Url(key);
          img.alt = '';
          stack.appendChild(img);
        });
        card.appendChild(stack);
      }

      const tagsEl = document.createElement('div');
      tagsEl.className = 'event-tags';
      (ev.tags || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => {
        tagsEl.appendChild(tagPill(t));
      });
      if (tagsEl.children.length) card.appendChild(tagsEl);

      list.appendChild(card);
    }

    if (location.hash) {
      const target = document.querySelector(location.hash);
      if (target) target.scrollIntoView();
    }
  } catch (e) {
    list.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
