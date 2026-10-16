// ================================================================
// MOISDES — SINGLE VIDEO PAGE (/video/post.html?id=)
// video-post.js — the actual player (with whatever branding it
// carries) only ever renders here, never on the listing page.
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const wrap = document.getElementById('video-detail');

  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  let currentGallery = [];
  let currentIndex = 0;
  function openLightbox(gallery, index) {
    currentGallery = gallery;
    currentIndex = index;
    lightboxImg.src = gallery[index];
    lightbox.classList.add('open');
  }
  function closeLightbox() { lightbox.classList.remove('open'); }
  function step(delta) {
    if (!currentGallery.length) return;
    currentIndex = (currentIndex + delta + currentGallery.length) % currentGallery.length;
    lightboxImg.src = currentGallery[currentIndex];
  }
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-prev').addEventListener('click', () => step(-1));
  document.getElementById('lightbox-next').addEventListener('click', () => step(1));
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') step(1);
    if (e.key === 'ArrowRight') step(-1);
  });

  function tagPill(tag) {
    const a = document.createElement('a');
    a.className = 'tag-pill';
    a.textContent = tag;
    a.href = `/search/?tag=${encodeURIComponent(tag)}`;
    return a;
  }
  function youtubeId(url) {
    if (!url) return null;
    const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  }

  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    wrap.innerHTML = '<h1 class="page-title">דער ווידיאו נישט געפונען</h1>';
    return;
  }

  try {
    const { videos } = await api.get('/api/videos');
    const v = videos.find((x) => String(x.id) === String(id));
    if (!v) {
      wrap.innerHTML = '<h1 class="page-title">דער ווידיאו נישט געפונען</h1>';
      return;
    }
    document.title = `${v.title} — חצר וויען`;

    const ytId = youtubeId(v.video_url);
    const videoEmbed = v.video_file_url
      ? `<video class="video-embed-native" controls src="${util.eh(api.r2Url(v.video_file_url))}"></video>`
      : (ytId ? `<div class="video-embed"><iframe src="https://www.youtube.com/embed/${ytId}?modestbranding=1&rel=0" allowfullscreen loading="lazy"></iframe></div>` : '');

    wrap.innerHTML = `
      ${videoEmbed}
      <div class="event-meta">${hebrew.isoToHebrewString(v.date)}${v.location ? ' · ' + util.eh(v.location) : ''}${v.category ? ' · ' + util.eh(v.category) : ''}</div>
      <h1 class="page-title" style="border:none;margin-bottom:.75rem">${util.eh(v.title)}</h1>
      <div class="detail-top-row">
        <div class="event-tags" data-tags></div>
        <div data-share></div>
      </div>
      <div class="detail-body">${v.description || ''}</div>
      <div class="stack" data-gallery style="margin-top:1.5rem"></div>
    `;

    if (v.folder_url) {
      const keys = await api.listFolder(v.folder_url).catch(() => []);
      const gallery = keys.map((k) => api.r2Url(k));
      const galleryEl = wrap.querySelector('[data-gallery]');
      gallery.forEach((url, i) => {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.addEventListener('click', () => openLightbox(gallery, i));
        galleryEl.appendChild(img);
      });
      if (!gallery.length) galleryEl.remove();
    } else {
      wrap.querySelector('[data-gallery]').remove();
    }

    const tagsEl = wrap.querySelector('[data-tags]');
    (v.tags || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => tagsEl.appendChild(tagPill(t)));
    if (!tagsEl.children.length) tagsEl.remove();

    if (window.MOISDES.shareButton) {
      wrap.querySelector('[data-share]').appendChild(window.MOISDES.shareButton(location.href, v.title));
    }
  } catch (e) {
    wrap.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
