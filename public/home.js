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
    post: { label: 'בלאג', href: (data) => `/blog/post.html?id=${data.id}` },
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
    try {
      const [postsR, postersR, eventsR, videosR, pdfsR] = await Promise.all([
        api.get('/api/posts').catch(() => ({ posts: [] })),
        api.get('/api/posters').catch(() => ({ posters: [] })),
        api.get('/api/events').catch(() => ({ events: [] })),
        api.get('/api/videos').catch(() => ({ videos: [] })),
        api.get('/api/pdfs').catch(() => ({ pdfs: [] })),
      ]);
      const byType = {
        post: [...postsR.posts].sort((a, b) => util.dateDesc(a.date, b.date)),
        poster: [...postersR.posters].sort((a, b) => util.dateDesc(a.date, b.date)),
        event: [...eventsR.events].sort((a, b) => util.dateDesc(a.date, b.date)),
        video: [...videosR.videos].sort((a, b) => util.dateDesc(a.date, b.date)),
        pdf: [...pdfsR.pdfs].sort((a, b) => util.dateDesc(a.date, b.date)),
      };
      const allFlat = Object.entries(byType).flatMap(([type, arr]) => arr.map((data) => ({ type, data })));
      allFlat.sort((a, b) => util.dateDesc(a.data.date, b.data.date));

      if (!allFlat.length) {
        mosaicEl.innerHTML = '<p class="state-msg">נאך קיין אינהאלט נישט פארעפנטליכט</p>';
        return;
      }
      // Curate exactly 10 for the mosaic: newest blog post always
      // included (and always the "big" tile), one of every other
      // section guaranteed, rest filled by overall recency.
      const chosen = [];
      const chosenSet = new Set();
      function add(type, data) {
        const k = itemKey(type, data);
        if (chosenSet.has(k)) return;
        chosenSet.add(k);
        chosen.push({ type, data });
      }
      const featuredPost = byType.post[0];
      if (featuredPost) add('post', featuredPost);
      ['poster', 'event', 'video', 'pdf'].forEach((t) => { if (byType[t][0]) add(t, byType[t][0]); });
      for (const it of allFlat) {
        if (chosen.length >= 10) break;
        add(it.type, it.data);
      }
      chosen.sort((a, b) => util.dateDesc(a.data.date, b.data.date));

      mosaicEl.innerHTML = '';
      // First tile (newest post) is always the big feature. Beyond that,
      // a couple of tiles in each half of the grid get a wide/tall span
      // for a proper magazine rhythm — otherwise every non-featured tile
      // is a uniform 1x1, which looks flat next to the one big tile.
      const SIZE_BY_INDEX = { 0: 'mosaic-big', 2: 'mosaic-tall', 3: 'mosaic-wide', 7: 'mosaic-tall', 8: 'mosaic-wide' };
      for (let i = 0; i < chosen.length; i++) {
        const { type, data } = chosen[i];
        const tile = await renderMosaicTile(type, data, SIZE_BY_INDEX[i] || '');
        mosaicEl.appendChild(tile);
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
      mosaicEl.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
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
          const hebcalText = await Z.hebcalDateText(heb.effectiveIso, heb.ohrLyom);
          const hebText = hebcalText || heb.text;
          const { zmanim: z, source } = await Z.computeZmanimWithHebcal(new Date(), loc.lat, loc.lon, loc.elevation, util.localIso());
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

  // ── DAF TODAY (ובהם נהגה) — follows the same shkia+72 rollover as the
  // Hebrew date above, since this is a "daily" program in the halachic sense.
  async function loadDaf() {
    const dafEl = document.getElementById('daf-widget');
    if (!dafEl) return;
    try {
      const { entries } = await api.get('/api/daf-entries');
      const effectiveIso = await new Promise((resolve) => {
        if (!window.MOISDES.zmanim) return resolve(util.localIso());
        window.MOISDES.zmanim.withLocation((loc) => {
          resolve(window.MOISDES.zmanim.currentHebrewDateDisplay(loc.lat, loc.lon, loc.elevation).effectiveIso);
        });
      });
      const entry = entries.find((e) => e.date === effectiveIso);
      dafEl.innerHTML = `
        <div class="daf-widget-row">
          <img class="daf-source-logo" src="/daf-logo.png" alt="חבורת ובהם נהגה">
          <div class="daf-widget-content">
            <div class="widget-title">ובהם נהגה</div>
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

  // Everything the home page shows runs concurrently; the loading
  // overlay only lifts once ALL of it — mosaic, zmanim, daf, upcoming —
  // has actually finished, so nothing pops in after the animation ends.
  await Promise.all([loadMosaic(), loadZmanim(), loadDaf(), loadUpcoming()]);
  if (window.MOISDES.hideLoadingOverlay) window.MOISDES.hideLoadingOverlay();

  // Simchas ticker is handled globally by chrome.js (runs on every page).
})();
