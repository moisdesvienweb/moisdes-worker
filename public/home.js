// ================================================================
// MOISDES — HOME PAGE
// home.js
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;

  const mosaicEl = document.getElementById('home-mosaic');

  function excerpt(html, len) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > len ? text.slice(0, len) + '…' : text;
  }

  function youtubeId(url) {
    if (!url) return null;
    const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  }

  // ── MAGAZINE-STYLE MOSAIC: all content types merged into one grid,
  // newest first, with a few tiles sized bigger for visual variety.
  const TYPE_META = {
    post: { label: 'מהנעשה והנשמע', href: (data) => `/blog/post.html?id=${data.id}` },
    poster: { label: 'מודעה', href: (data) => `${window.MOISDES.CFG.pages.posters}#poster-${data.id}` },
    event: { label: 'מעמד', href: (data) => `/events/post.html?id=${data.id}` },
    video: { label: 'ווידיאו', href: (data) => `/video/post.html?id=${data.id}` },
    pdf: { label: 'גליון', href: (data) => `${window.MOISDES.CFG.pages.pdfs}#pdf-${data.id}` },
  };

  function titleFor(type, data) {
    if (type === 'poster') return data.parsha ? `מודעה — ${data.parsha}` : 'מודעה';
    return data.title || '';
  }

  async function imageFor(type, data) {
    if (type === 'event') return data.thumb_url ? api.r2Url(data.thumb_url) : api.firstImageUrl(data.folder_url);
    if (type === 'video') {
      const ytId = youtubeId(data.video_url);
      if (ytId) return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
      return api.firstImageUrl(data.folder_url);
    }
    if (type === 'pdf') return data.thumb_url ? api.r2Url(data.thumb_url) : null;
    return api.firstImageUrl(data.folder_url);
  }

  function itemKey(type, data) { return `${type}-${data.id}`; }

  async function renderMosaicTile(type, data, sizeClass) {
    const meta = TYPE_META[type];
    const img = await imageFor(type, data);
    const tile = document.createElement('a');
    tile.className = 'mosaic-item' + (sizeClass ? ' ' + sizeClass : '');
    tile.href = meta.href(data);
    tile.innerHTML = `
      ${img ? `<div class="mosaic-media" style="background-image:url('${util.eh(img)}')"></div>` : ''}
      <div class="mosaic-overlay">
        <span class="mosaic-badge">${meta.label}</span>
        <div class="mosaic-title">${util.eh(titleFor(type, data))}</div>
        <div class="mosaic-date">${hebrew.isoToHebrewString(data.date)}</div>
      </div>
    `;
    return tile;
  }

  // The home mosaic's big slot, as a 3D crossfade carousel over every
  // post marked "featured" in the admin — main image + title + a short
  // excerpt per slide, auto-advancing every 6 seconds. Falls back to a
  // single static tile (renderMosaicTile) when nothing's featured.
  async function renderFeaturedSpotlight(posts) {
    const box = document.createElement('div');
    box.className = 'mosaic-item mosaic-big mosaic-featured';
    const stage = document.createElement('div');
    stage.className = 'featured-slideshow';
    box.appendChild(stage);

    const slides = [];
    for (const data of posts) {
      const img = await imageFor('post', data);
      const slide = document.createElement('a');
      slide.className = 'featured-slide';
      slide.href = TYPE_META.post.href(data);
      slide.innerHTML = `
        ${img ? `<div class="mosaic-media" style="background-image:url('${util.eh(img)}')"></div>` : ''}
        <div class="mosaic-overlay">
          <span class="mosaic-badge">${TYPE_META.post.label}</span>
          <div class="mosaic-title">${util.eh(titleFor('post', data))}</div>
          <div class="mosaic-excerpt">${util.eh(excerpt(data.body, 110))}</div>
          <div class="mosaic-date">${hebrew.isoToHebrewString(data.date)}</div>
        </div>
      `;
      stage.appendChild(slide);
      slides.push(slide);
    }
    slides[0].classList.add('active');

    if (slides.length > 1) {
      const dots = document.createElement('div');
      dots.className = 'featured-dots';
      const dotEls = slides.map((_, i) => {
        const dot = document.createElement('span');
        dot.className = 'featured-dot' + (i === 0 ? ' active' : '');
        dots.appendChild(dot);
        return dot;
      });
      box.appendChild(dots);

      let idx = 0;
      setInterval(() => {
        slides[idx].classList.remove('active');
        dotEls[idx].classList.remove('active');
        idx = (idx + 1) % slides.length;
        slides[idx].classList.add('active');
        dotEls[idx].classList.add('active');
      }, 6000);
    }

    return box;
  }

  function renderMoreCard(type, data, img) {
    const meta = TYPE_META[type];
    const card = document.createElement('a');
    card.className = 'card';
    card.href = meta.href(data);
    card.innerHTML = `
      <div class="card-media">${img ? `<img src="${util.eh(img)}" alt="">` : ''}</div>
      <div class="card-body">
        <div class="card-date">${meta.label} · ${hebrew.isoToHebrewString(data.date)}</div>
        <div class="card-title">${util.eh(titleFor(type, data))}</div>
      </div>`;
    return card;
  }

  const moreGrid = document.getElementById('home-more-grid');
  const moreBtn = document.getElementById('home-more-btn');
  let remaining = [];
  const PAGE_SIZE = 10;

  async function loadMoreBatch() {
    const batch = remaining.splice(0, PAGE_SIZE);
    for (const { type, data } of batch) {
      const img = await imageFor(type, data);
      moreGrid.appendChild(renderMoreCard(type, data, img));
    }
    moreBtn.style.display = remaining.length ? '' : 'none';
  }

  async function loadMosaic() {
    // The Worker pre-renders this same mosaic straight into the page's
    // HTML (see handleHomePage in index.js) whenever it can — in that
    // case the content the visitor sees is already final on first paint,
    // and this whole function just needs to fetch the feed for the
    // "more news" strip/button below it, not rebuild what's already there.
    const alreadyRendered = mosaicEl.dataset.ssr === '1';
    try {
      // One combined request instead of five separate ones — same data,
      // one round trip (and edge-cached on the Worker side too).
      const feed = await api.get('/api/home-feed');
      const byType = {
        post: [...(feed.posts || [])].sort((a, b) => util.dateDesc(a.date, b.date)),
        poster: [...(feed.posters || [])].sort((a, b) => util.dateDesc(a.date, b.date)),
        event: [...(feed.events || [])].sort((a, b) => util.dateDesc(a.date, b.date)),
        video: [...(feed.videos || [])].sort((a, b) => util.dateDesc(a.date, b.date)),
        pdf: [...(feed.pdfs || [])].sort((a, b) => util.dateDesc(a.date, b.date)),
      };
      const allFlat = Object.entries(byType).flatMap(([type, arr]) => arr.map((data) => ({ type, data })));
      allFlat.sort((a, b) => util.dateDesc(a.data.date, b.data.date));

      if (!allFlat.length) {
        if (!alreadyRendered) mosaicEl.innerHTML = '<p class="state-msg">נאך קיין אינהאלט נישט פארעפנטליכט</p>';
        return;
      }

      if (!alreadyRendered) {
        // The big slot is a rotating spotlight of every post marked
        // "featured" in the admin, if there are any — otherwise it falls
        // back to the single newest post, same as before.
        const featuredPosts = byType.post.filter((p) => Number(p.featured)).slice(0, 8);
        const hasSpotlight = featuredPosts.length > 0;

        // Curate the rest: one of every other section guaranteed, rest
        // filled by overall recency, up to 10 tiles total counting the
        // spotlight slot. (index.js also has a renderHomeMosaicHtml that
        // mirrors this for server-side pre-rendering, but that path is
        // currently disabled — see wrangler.toml — so it's not in sync
        // with this spotlight logic right now; update it too if SSR is
        // ever turned back on.)
        const chosen = [];
        const chosenSet = new Set();
        function add(type, data) {
          const k = itemKey(type, data);
          if (chosenSet.has(k)) return;
          chosenSet.add(k);
          chosen.push({ type, data });
        }
        if (hasSpotlight) {
          featuredPosts.forEach((p) => chosenSet.add(itemKey('post', p)));
        } else if (byType.post[0]) {
          add('post', byType.post[0]);
        }
        ['poster', 'event', 'video', 'pdf'].forEach((t) => { if (byType[t][0]) add(t, byType[t][0]); });
        const targetCount = hasSpotlight ? 9 : 10;
        for (const it of allFlat) {
          if (chosen.length >= targetCount) break;
          add(it.type, it.data);
        }
        chosen.sort((a, b) => util.dateDesc(a.data.date, b.data.date));

        mosaicEl.innerHTML = '';
        // The spotlight (or, without one, the newest post) is always the
        // big feature in slot 0. Beyond that, a couple of tiles in each
        // half of the grid get a wide/tall span for a proper magazine
        // rhythm — otherwise every tile is a uniform 1x1, which looks
        // flat next to the one big tile.
        const SIZE_BY_INDEX = { 0: 'mosaic-big', 2: 'mosaic-tall', 3: 'mosaic-wide', 7: 'mosaic-tall', 8: 'mosaic-wide' };
        if (hasSpotlight) mosaicEl.appendChild(await renderFeaturedSpotlight(featuredPosts));
        const indexOffset = hasSpotlight ? 1 : 0;
        for (let i = 0; i < chosen.length; i++) {
          const { type, data } = chosen[i];
          const tile = await renderMosaicTile(type, data, SIZE_BY_INDEX[i + indexOffset] || '');
          mosaicEl.appendChild(tile);
        }
      }

      // "More news" is the full recent list in date order — it's fine
      // (expected, even) for it to repeat what's already featured above
      // in the mosaic, rather than hiding those items entirely.
      remaining = allFlat.slice();
      if (remaining.length) {
        moreBtn.addEventListener('click', loadMoreBatch);
        await loadMoreBatch();
      } else {
        moreBtn.style.display = 'none';
      }
    } catch (e) {
      if (!alreadyRendered) mosaicEl.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
    }
  }

  // ── ZMANIM + HEBREW DATE (rolls over at shkia+72, not midnight) ────
  function loadZmanim() {
    const zmanimEl = document.getElementById('zmanim-widget');
    if (!zmanimEl || !window.MOISDES.zmanim) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      window.MOISDES.zmanim.withLocation(async (loc) => {
        try {
          const Z = window.MOISDES.zmanim;
          const heb = Z.currentHebrewDateDisplay(loc.lat, loc.lon, loc.elevation);
          // These two network calls don't depend on each other — running
          // them together instead of one-after-the-other roughly halves
          // this widget's own network time.
          const [hebcalText, zmanimResult] = await Promise.all([
            Z.hebcalDateText(heb.effectiveIso, heb.ohrLyom),
            Z.computeZmanimWithHebcal(new Date(), loc.lat, loc.lon, loc.elevation, util.localIso()),
          ]);
          const hebText = hebcalText || heb.text;
          const { zmanim: z, source } = zmanimResult;
          const usedHebcal = source === 'hebcal' || !!hebcalText;
          const rows = [
            ['הנץ החמה', Z.fmtTime(z.sunrise)],
            ['סוף זמן ק"ש (מג"א)', Z.fmtTime(z.sofZmanShemaEarly)],
            ['סוף זמן ק"ש (גר"א)', Z.fmtTime(z.sofZmanShemaLate)],
            ['סוף זמן תפילה (מג"א)', Z.fmtTime(z.sofZmanTfilahEarly)],
            ['סוף זמן תפילה (גר"א)', Z.fmtTime(z.sofZmanTfilahLate)],
            ['חצות', Z.fmtTime(z.chatzos)],
            ['שקיעה', Z.fmtTime(z.sunset)],
            ['צאת (60)', Z.fmtTime(z.tzeis60)],
            ['צאת (72)', Z.fmtTime(z.tzeis72)],
          ];
          const englishDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          zmanimEl.innerHTML = `
            <div class="widget-title">${util.eh(hebText)}</div>
            <div class="widget-eng-date">${util.eh(englishDate)}</div>
            <div class="zmanim-grid">${rows.map(([l, v]) => `<div class="zman-item"><span class="zman-label">${util.eh(l)}</span><span class="zman-value">${util.eh(v)}</span></div>`).join('')}</div>
            <div class="zman-machmir">נא להחמיר על הזמנים בכמה דקות.</div>
            ${usedHebcal ? `<div class="zman-attribution">Date &amp; zmanim via <a href="https://www.hebcal.com" target="_blank" rel="noopener">Hebcal.com</a></div>` : ''}
            <div class="widget-loc">${util.eh(loc.label)}</div>
          `;
        } catch (e) {
          zmanimEl.innerHTML = '<p class="state-msg">נישט געקענט רעכענען זמנים</p>';
        }
        // withLocation calls back a second time once reverse-geocoding
        // upgrades the label — only the first (fast) call should gate
        // the loading overlay, the label just quietly updates after.
        if (!settled) { settled = true; resolve(); }
      });
    });
  }

  // ── DAF TODAY (ובהם נהגה) — rolls over at a fixed 2:00 AM local time
  // (not sunset+72 like the Hebrew-date/zmanim widget — this one's tied
  // to a daily upload schedule, not a halachic day), so no geolocation
  // is needed for it at all.
  const DAF_DAY_NAMES = ['זונטאג', 'מאנטאג', 'דינסטאג', 'מיטוואך', 'דאנערשטאג', 'פרייטאג', 'שבת'];
  function dafEffectiveDate() {
    const now = new Date();
    if (now.getHours() < 2) now.setDate(now.getDate() - 1);
    return now;
  }
  async function loadDaf() {
    const dafEl = document.getElementById('daf-widget');
    if (!dafEl) return;
    try {
      const { entries } = await api.get('/api/daf-entries');
      const effectiveDate = dafEffectiveDate();
      const effectiveIso = util.localIso(effectiveDate);
      const dayName = DAF_DAY_NAMES[effectiveDate.getDay()];
      const hebrewDate = window.MOISDES.hebrew ? window.MOISDES.hebrew.isoToHebrewString(effectiveIso) : '';
      const entry = entries.find((e) => e.date === effectiveIso);
      dafEl.innerHTML = `
        <div class="daf-widget-row">
          <img class="daf-source-logo" src="/daf-logo.png" alt="חבורת ובהם נהגה">
          <div class="daf-widget-content">
            <div class="widget-title">ובהם נהגה</div>
            <div class="widget-sub-date">${util.eh(dayName)}${hebrewDate ? ', ' + util.eh(hebrewDate) : ''}</div>
            <div>${entry ? util.eh(entry.text) : 'נאך נישט אריינגעשטעלט'}</div>
          </div>
        </div>
      `;
    } catch (e) {
      dafEl.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
    }
  }

  // ── UPCOMING (מעמדים און שמחות, from the synced calendar) — a small
  // horizontal-scrolling strip, not a full list; "see all" links to /calendar.
  async function loadUpcoming() {
    const upcomingEl = document.getElementById('home-upcoming');
    if (!upcomingEl) return;
    try {
      const { events } = await api.get('/api/gcal-events');
      const todayIso = util.localIso();
      const recent = events.filter((ev) => ev.date >= todayIso).slice(0, 5);
      if (!recent.length) {
        upcomingEl.innerHTML = '<p class="state-msg">נאך קיין געשעענישן אין קאלענדאר</p>';
        return;
      }
      upcomingEl.innerHTML = '';
      recent.forEach((ev) => {
        const card = document.createElement('a');
        card.className = 'upcoming-card';
        card.href = '/calendar';
        card.innerHTML = `
          <div class="upcoming-card-title">${util.eh(ev.summary)}</div>
          <div class="upcoming-card-date">${hebrew.isoToHebrewString(ev.date)}</div>
        `;
        upcomingEl.appendChild(card);
      });
    } catch (e) {
      upcomingEl.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
    }
  }

  // ── TAGS (sidebar) — only featured tags show up front; everything else
  // stays behind "מער" until clicked. Each tag links to the search page's
  // exact-match tag filter (already supported by search.js via ?tag=).
  async function loadTagsWidget() {
    const widget = document.getElementById('tags-widget');
    const listEl = document.getElementById('tags-widget-list');
    const moreBtn = document.getElementById('tags-widget-more');
    if (!widget || !listEl) return;
    try {
      const { tags, featured } = await api.get('/api/tags');
      if (!tags || !tags.length) return; // stays hidden — nothing to show yet
      const featuredSet = new Set(featured || []);
      const rest = tags.filter((t) => !featuredSet.has(t)).sort((a, b) => a.localeCompare(b));
      const ordered = [...(featured || []).slice().sort((a, b) => a.localeCompare(b)), ...rest];

      function tagEl(name) {
        const a = document.createElement('a');
        a.className = 'tags-widget-tag' + (featuredSet.has(name) ? ' is-featured' : '');
        a.href = `/search/?tag=${encodeURIComponent(name)}`;
        a.textContent = name;
        return a;
      }

      listEl.innerHTML = '';
      ordered.slice(0, featuredSet.size).forEach((name) => listEl.appendChild(tagEl(name)));

      const hidden = ordered.slice(featuredSet.size);
      if (hidden.length) {
        moreBtn.style.display = '';
        moreBtn.textContent = `מער ← (${hidden.length})`;
        moreBtn.addEventListener('click', () => {
          hidden.forEach((name) => listEl.appendChild(tagEl(name)));
          listEl.classList.add('is-expanded');
          moreBtn.style.display = 'none';
        });
      }

      widget.style.display = '';
    } catch (e) { /* sidebar widget — fails quietly, nothing critical lost */ }
  }

  // Only the main "נייעס" content gates the loading overlay — zmanim,
  // daf, and upcoming are sidebar/strip widgets that each already have
  // their own "Loading…" placeholder in the HTML, so there's no reason
  // to hide the whole page behind the overlay while they're still in
  // flight. This matters a lot in practice: zmanim specifically waits on
  // a geolocation request that can take several seconds (or longer, if
  // the permission prompt sits unanswered) before it even starts its own
  // network calls — the rest of the page shouldn't be invisible for all
  // of that. They still run concurrently with the mosaic, just without
  // blocking it.
  loadZmanim();
  loadDaf();
  loadUpcoming();
  loadTagsWidget();
  await loadMosaic();
  if (window.MOISDES.hideLoadingOverlay) window.MOISDES.hideLoadingOverlay();

  // Simchas ticker is handled globally by chrome.js (runs on every page).
})();
