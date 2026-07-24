// ================================================================
// MOISDES — BLOG PAGE
// blog.js
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const list = document.getElementById('blog-list');
  const bannerEl = document.getElementById('tag-filter-banner');

  const params = new URLSearchParams(location.search);
  const activeTag = params.get('tag');

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
    a.href = `/blog?tag=${encodeURIComponent(tag)}`;
    return a;
  }

  if (activeTag) {
    bannerEl.innerHTML = `<div class="tag-filter-banner">מציג רעזולטאטן פארן טאג: <strong>${util.eh(activeTag)}</strong> · <a href="/blog">מעק אויס</a></div>`;
  }

  try {
    const { posts } = await api.get('/api/posts');
    const filtered = activeTag
      ? posts.filter((p) => (p.tags || '').split(',').map((t) => t.trim()).includes(activeTag))
      : posts;

    if (!filtered.length) {
      list.innerHTML = '<p class="state-msg">נאך קיין בילדער נישט פארעפנטליכט</p>';
      return;
    }
    list.innerHTML = '';
    for (const post of filtered) {
      const keys = await api.listFolder(post.folder_url).catch(() => []);
      const gallery = keys.map((k) => api.r2Url(k));

      const article = document.createElement('article');
      article.className = 'event-card';
      article.id = `post-${post.id}`;
      article.innerHTML = `
        <div class="event-meta">${hebrew.isoToHebrewString(post.date)}${post.category ? ' · ' + util.eh(post.category) : ''}</div>
        <h2 class="event-title">${util.eh(post.title)}</h2>
        <div class="event-desc">${post.body || ''}</div>
        <div class="stack" data-gallery></div>
        <div class="event-tags"></div>
      `;

      const galleryEl = article.querySelector('[data-gallery]');
      gallery.forEach((url, i) => {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.addEventListener('click', () => openLightbox(gallery, i));
        galleryEl.appendChild(img);
      });
      if (!gallery.length) galleryEl.remove();

      const tagsEl = article.querySelector('.event-tags');
      (post.tags || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => {
        tagsEl.appendChild(tagPill(t));
      });
      if (!tagsEl.children.length) tagsEl.remove();

      list.appendChild(article);
    }

    if (location.hash) {
      const target = document.querySelector(location.hash);
      if (target) target.scrollIntoView();
    }
  } catch (e) {
    list.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
