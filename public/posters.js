// ================================================================
// MOISDES — POSTERS PAGE
// posters.js — grouped by Hebrew year, then by parsha.
// Each poster shows every uploaded image, stacked and full-view.
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const list = document.getElementById('posters-list');

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

  try {
    const { posters } = await api.get('/api/posters');
    if (!posters.length) {
      list.innerHTML = '<p class="state-msg">נאך קיין מודעות נישט פארעפנטליכט</p>';
      return;
    }

    const sorted = [...posters].sort((a, b) => util.dateDesc(a.date, b.date));

    // Group by Hebrew year, then by parsha, preserving first-seen order.
    const years = new Map();
    for (const poster of sorted) {
      const hebYear = hebrew.isoToHebrew(poster.date).year;
      if (!years.has(hebYear)) years.set(hebYear, new Map());
      const parshaMap = years.get(hebYear);
      const parsha = poster.parsha || 'אנדערש';
      if (!parshaMap.has(parsha)) parshaMap.set(parsha, []);
      parshaMap.get(parsha).push(poster);
    }

    list.innerHTML = '';
    for (const [year, parshaMap] of years) {
      const yearHeading = document.createElement('h2');
      yearHeading.className = 'year-heading';
      yearHeading.textContent = hebrew.yearToHebrew(year);
      list.appendChild(yearHeading);

      for (const [parsha, items] of parshaMap) {
        const parshaHeading = document.createElement('h3');
        parshaHeading.className = 'parsha-heading';
        parshaHeading.textContent = 'פרשת ' + parsha;
        list.appendChild(parshaHeading);

        for (const poster of items) {
          const keys = await api.listFolder(poster.folder_url).catch(() => []);
          const gallery = keys.map((k) => api.r2Url(k));

          const item = document.createElement('div');
          item.className = 'poster-item stack';
          item.id = `poster-${poster.id}`;
          gallery.forEach((url, i) => {
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            img.addEventListener('click', () => openLightbox(gallery, i));
            item.appendChild(img);
          });
          list.appendChild(item);
        }
      }
    }

    if (location.hash) {
      const target = document.querySelector(location.hash);
      if (target) target.scrollIntoView();
    }
  } catch (e) {
    list.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
