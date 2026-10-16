// ================================================================
// MOISDES — BLOG PAGE (grid of uniform cards -> /blog/post.html?id=)
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

  function excerpt(html, len) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > len ? text.slice(0, len) + '…' : text;
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
    const sorted = [...filtered].sort((a, b) => util.dateDesc(a.date, b.date));
    list.innerHTML = '';

    for (const post of sorted) {
      const img = await api.firstImageUrl(post.folder_url);
      const card = document.createElement('a');
      card.href = `/blog/post.html?id=${post.id}`;
      card.className = 'card';
      card.id = `post-${post.id}`;
      card.innerHTML = `
        <div class="card-media">${img ? `<img src="${util.eh(img)}" alt="">` : ''}</div>
        <div class="card-body">
          <div class="card-date">${hebrew.isoToHebrewString(post.date)}${post.category ? ' · ' + util.eh(post.category) : ''}</div>
          <div class="card-title">${util.eh(post.title)}</div>
          <p class="card-excerpt">${util.eh(excerpt(post.body, 90))}</p>
        </div>`;
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
