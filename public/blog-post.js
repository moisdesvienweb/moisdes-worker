// ================================================================
// MOISDES — SINGLE BLOG POST PAGE (/blog/post.html?id=)
// blog-post.js
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const wrap = document.getElementById('post-detail');

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

  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    wrap.innerHTML = '<h1 class="page-title">דער בלאג נישט געפונען</h1>';
    return;
  }

  try {
    const { posts } = await api.get('/api/posts');
    const post = posts.find((p) => String(p.id) === String(id));
    if (!post) {
      wrap.innerHTML = '<h1 class="page-title">דער בלאג נישט געפונען</h1>';
      return;
    }
    document.title = `${post.title} — חצר וויען`;

    const keys = await api.listFolder(post.folder_url).catch(() => []);
    const gallery = keys.map((k) => api.r2Url(k));

    wrap.innerHTML = `
      <div class="event-meta">${hebrew.isoToHebrewString(post.date)}${post.category ? ' · ' + util.eh(post.category) : ''}</div>
      <h1 class="page-title" style="border:none;margin-bottom:.75rem">${util.eh(post.title)}</h1>
      <div class="detail-top-row">
        <div class="event-tags" data-tags></div>
        <div data-share></div>
      </div>
      <div class="detail-body">${post.body || ''}</div>
      <div class="stack" data-gallery style="margin-top:1.5rem"></div>
    `;

    const galleryEl = wrap.querySelector('[data-gallery]');
    gallery.forEach((url, i) => {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.addEventListener('click', () => openLightbox(gallery, i));
      galleryEl.appendChild(img);
    });
    if (!gallery.length) galleryEl.remove();

    const tagsEl = wrap.querySelector('[data-tags]');
    (post.tags || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => tagsEl.appendChild(tagPill(t)));
    if (!tagsEl.children.length) tagsEl.remove();

    if (window.MOISDES.shareButton) {
      wrap.querySelector('[data-share]').appendChild(window.MOISDES.shareButton(location.href, post.title));
    }
  } catch (e) {
    wrap.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
