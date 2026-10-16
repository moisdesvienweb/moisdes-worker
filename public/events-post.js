// ================================================================
// MOISDES — SINGLE EVENT PAGE (/events/post.html?id=)
// events-post.js — full detail page (cover, description, custom-styled
// audio playlist, photo gallery) that used to live in a popup on the
// events listing page. Each event now has its own shareable URL instead.
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const wrap = document.getElementById('event-detail');

  const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'wma', 'amr', 'caf', '3gp', '3gpp', 'weba', 'mp4'];
  function isAudio(key) { return AUDIO_EXT.includes(key.split('.').pop().toLowerCase()); }

  // ── LIGHTBOX (photo gallery zoom) ──────────────────────────────────
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

  // ── CUSTOM AUDIO PLAYER (no native browser controls at all — a plain
  // white OS-styled player was the whole complaint, so this drives a
  // headless <audio> element with our own play/seek/volume UI instead) ──
  const ICON_PLAY = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  const ICON_VOL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 00-2.5-4.03v8.06A4.5 4.5 0 0016.5 12z"/></svg>';
  const ICON_MUTE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3zm12.59 2l2.7-2.71-1.41-1.41L14.18 10l-2.7-2.71-1.41 1.41L12.77 11l-2.7 2.71 1.41 1.41 2.7-2.7 2.7 2.7 1.41-1.41L15.59 12z"/></svg>';

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function buildAudioPlayer(audioKeys) {
    const trackName = (key) => key.split('/').pop().replace(/^\d{4}-/, '').replace(/\.[^.]+$/, '');

    const player = document.createElement('div');
    player.className = 'playlist-player';
    const nowPlaying = document.createElement('div');
    nowPlaying.className = 'track-name';

    const audio = document.createElement('audio'); // headless — no controls attribute, no native UI

    const controls = document.createElement('div');
    controls.className = 'audio-player';
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'player-btn player-playpause';
    playBtn.innerHTML = ICON_PLAY;
    playBtn.setAttribute('aria-label', 'שפילן');

    const progressWrap = document.createElement('div');
    progressWrap.className = 'player-progress-wrap';
    const progressBg = document.createElement('div');
    progressBg.className = 'player-progress-bg';
    const progressFill = document.createElement('div');
    progressFill.className = 'player-progress-fill';
    const progressHandle = document.createElement('div');
    progressHandle.className = 'player-progress-handle';
    progressBg.appendChild(progressFill);
    progressBg.appendChild(progressHandle);
    progressWrap.appendChild(progressBg);

    const timeEl = document.createElement('div');
    timeEl.className = 'player-time';
    timeEl.textContent = '0:00 / 0:00';

    const volWrap = document.createElement('div');
    volWrap.className = 'player-volume';
    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'player-btn player-mute';
    muteBtn.innerHTML = ICON_VOL;
    muteBtn.setAttribute('aria-label', 'שטומען');
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.01'; volSlider.value = '1';
    volSlider.className = 'player-volume-slider';
    volWrap.appendChild(muteBtn);
    volWrap.appendChild(volSlider);

    controls.appendChild(playBtn);
    controls.appendChild(progressWrap);
    controls.appendChild(timeEl);
    controls.appendChild(volWrap);

    const trackList = document.createElement('ul');
    trackList.className = 'playlist-tracks';

    let index = 0;
    function loadTrack(i, autoplay) {
      index = (i + audioKeys.length) % audioKeys.length;
      audio.src = api.r2Url(audioKeys[index]);
      if (autoplay) audio.play().catch(() => {});
      nowPlaying.textContent = `${index + 1}. ${trackName(audioKeys[index])}`;
      trackList.querySelectorAll('li').forEach((li, n) => li.classList.toggle('playing', n === index));
    }

    audioKeys.forEach((key, i) => {
      const li = document.createElement('li');
      const num = document.createElement('span');
      num.className = 'track-num';
      num.textContent = i + 1;
      const name = document.createElement('span');
      name.className = 'track-label';
      name.textContent = trackName(key);
      li.appendChild(num);
      li.appendChild(name);
      li.addEventListener('click', () => loadTrack(i, true));
      trackList.appendChild(li);
    });

    playBtn.addEventListener('click', () => {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    });
    audio.addEventListener('play', () => { playBtn.innerHTML = ICON_PAUSE; playBtn.setAttribute('aria-label', 'אפשטעלן'); });
    audio.addEventListener('pause', () => { playBtn.innerHTML = ICON_PLAY; playBtn.setAttribute('aria-label', 'שפילן'); });
    audio.addEventListener('timeupdate', () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      progressFill.style.width = pct + '%';
      progressHandle.style.left = pct + '%';
      timeEl.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
    });
    audio.addEventListener('loadedmetadata', () => {
      timeEl.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
    });
    audio.addEventListener('ended', () => { if (index < audioKeys.length - 1) loadTrack(index + 1, true); });

    function seekTo(clientX) {
      if (!audio.duration) return;
      const rect = progressBg.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      audio.currentTime = frac * audio.duration;
    }
    let seeking = false;
    progressBg.addEventListener('mousedown', (e) => { seeking = true; seekTo(e.clientX); });
    window.addEventListener('mousemove', (e) => { if (seeking) seekTo(e.clientX); });
    window.addEventListener('mouseup', () => { seeking = false; });
    progressBg.addEventListener('touchstart', (e) => { seeking = true; seekTo(e.touches[0].clientX); }, { passive: true });
    progressBg.addEventListener('touchmove', (e) => { if (seeking) seekTo(e.touches[0].clientX); }, { passive: true });
    progressBg.addEventListener('touchend', () => { seeking = false; });

    volSlider.addEventListener('input', () => {
      audio.volume = parseFloat(volSlider.value);
      audio.muted = audio.volume === 0;
      muteBtn.innerHTML = audio.muted ? ICON_MUTE : ICON_VOL;
    });
    muteBtn.addEventListener('click', () => {
      audio.muted = !audio.muted;
      volSlider.value = audio.muted ? '0' : String(audio.volume || 1);
      muteBtn.innerHTML = audio.muted ? ICON_MUTE : ICON_VOL;
    });

    player.appendChild(nowPlaying);
    player.appendChild(audio);
    player.appendChild(controls);
    if (audioKeys.length > 1) player.appendChild(trackList);

    loadTrack(0, false);
    return player;
  }

  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    wrap.innerHTML = '<h1 class="page-title">דער מעמד נישט געפונען</h1>';
    return;
  }

  try {
    const { events } = await api.get('/api/events');
    const ev = events.find((x) => String(x.id) === String(id));
    if (!ev) {
      wrap.innerHTML = '<h1 class="page-title">דער מעמד נישט געפונען</h1>';
      return;
    }
    document.title = `${ev.title} — חצר וויען`;

    const keys = await api.listFolder(ev.folder_url).catch(() => []);
    const audioKeys = keys.filter(isAudio);
    const imageKeys = keys.filter((k) => !isAudio(k));
    const coverUrl = ev.thumb_url ? api.r2Url(ev.thumb_url) : (imageKeys[0] ? api.r2Url(imageKeys[0]) : null);

    wrap.innerHTML = `
      ${coverUrl ? `<div class="event-modal-cover" style="margin-bottom:1rem;background-image:url('${util.eh(coverUrl)}')"></div>` : ''}
      <div class="event-meta">${hebrew.isoToHebrewString(ev.date)}${ev.category ? ' · ' + util.eh(ev.category) : ''}</div>
      <h1 class="page-title" style="border:none;margin-bottom:.75rem">${util.eh(ev.title)}</h1>
      <div class="detail-top-row">
        <div class="event-tags" data-tags></div>
        <div data-share></div>
      </div>
      ${ev.location ? `<div class="event-meta">${util.eh(ev.location)}</div>` : ''}
      <div class="detail-body">${ev.description || ''}</div>
      <div data-player></div>
      <div class="stack" data-gallery style="margin-top:1rem"></div>
    `;

    if (audioKeys.length) {
      wrap.querySelector('[data-player]').replaceWith(buildAudioPlayer(audioKeys));
    } else {
      wrap.querySelector('[data-player]').remove();
    }

    const galleryEl = wrap.querySelector('[data-gallery]');
    const remainingImages = ev.thumb_url ? imageKeys : imageKeys.slice(1);
    if (remainingImages.length) {
      const gallery = remainingImages.map((k) => api.r2Url(k));
      gallery.forEach((url, i) => {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.addEventListener('click', () => openLightbox(gallery, i));
        galleryEl.appendChild(img);
      });
    } else {
      galleryEl.remove();
    }

    const tagsEl = wrap.querySelector('[data-tags]');
    (ev.tags || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => tagsEl.appendChild(tagPill(t)));
    if (!tagsEl.children.length) tagsEl.remove();

    if (window.MOISDES.shareButton) {
      wrap.querySelector('[data-share]').appendChild(window.MOISDES.shareButton(location.href, ev.title));
    }
  } catch (e) {
    wrap.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
