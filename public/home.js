// ================================================================
// MOISDES — HOME PAGE
// home.js
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;

  const blogGrid = document.getElementById('home-blog-grid');
  const postersStrip = document.getElementById('home-posters-strip');

  function excerpt(html, len) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > len ? text.slice(0, len) + '…' : text;
  }

  try {
    const { posts } = await api.get('/api/posts');
    const recent = posts.slice(0, 6);
    if (!recent.length) {
      blogGrid.innerHTML = '<p class="state-msg">נאך קיין בילדער נישט פארעפנטליכט</p>';
    } else {
      blogGrid.innerHTML = '';
      for (const post of recent) {
        const img = await api.firstImageUrl(post.folder_url);
        const card = document.createElement('a');
        card.href = `${window.MOISDES.CFG.pages.blog}#post-${post.id}`;
        card.className = 'card';
        card.innerHTML = `
          <div class="card-media">${img ? `<img src="${util.eh(img)}" alt="">` : ''}</div>
          <div class="card-body">
            <div class="card-date">${hebrew.isoToHebrewString(post.date)}</div>
            <div class="card-title">${util.eh(post.title)}</div>
            <p class="card-excerpt">${util.eh(excerpt(post.body, 90))}</p>
          </div>`;
        blogGrid.appendChild(card);
      }
    }
  } catch (e) {
    blogGrid.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }

  try {
    const { posters } = await api.get('/api/posters');
    const recent = posters.slice(0, 10);
    if (!recent.length) {
      postersStrip.innerHTML = '<p class="state-msg">נאך קיין מודעות נישט פארעפנטליכט</p>';
    } else {
      postersStrip.innerHTML = '';
      for (const poster of recent) {
        const img = await api.firstImageUrl(poster.folder_url);
        const card = document.createElement('a');
        card.href = `${window.MOISDES.CFG.pages.posters}#poster-${poster.id}`;
        card.className = 'card';
        card.innerHTML = `
          <div class="card-media">${img ? `<img src="${util.eh(img)}" alt="">` : ''}</div>
          <div class="card-body">
            <div class="card-date">${util.eh(poster.parsha || '')}</div>
          </div>`;
        postersStrip.appendChild(card);
      }
    }
  } catch (e) {
    postersStrip.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
