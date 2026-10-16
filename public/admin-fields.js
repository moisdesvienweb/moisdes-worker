// ================================================================
// MOISDES ADMIN — reusable form widgets
// admin-fields.js
// Date picker (3 modes), tag pills, category input, gallery uploader.
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminFields = (function () {
  const api = window.MOISDES.api;
  const hebrew = window.MOISDES.hebrew;
  const CFG = window.MOISDES.CFG;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // Blacklist, not whitelist — keeps spaces, Hebrew/Yiddish, accents,
  // punctuation, parentheses, etc. Only strips characters that would
  // actually break a URL or an R2/S3 key (path separators, query/hash
  // markers, control characters).
  function sanitizeFilename(name) {
    return String(name).replace(/[\\/?#%:*"<>|\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(-120) || 'file';
  }

  // Walk forward from 1 Tishrei of `hebrewYear` looking for the Shabbat
  // whose week matches `parshaName` (reuses the same weekly rotation the
  // public site uses, so picker and display always agree).
  function parshaToIso(parshaName, hebrewYear) {
    const util = window.MOISDES.util;
    let iso = hebrew.hebrewToIso(hebrewYear, 1, 1);
    let d = new Date(iso + 'T12:00:00Z');
    const dow = d.getUTCDay();
    d = new Date(d.getTime() + ((6 - dow + 7) % 7) * 86400000); // first Shabbat on/after 1 Tishrei
    for (let i = 0; i < 60; i++) {
      const candidate = d.toISOString().slice(0, 10);
      if (util.dateToParsha(candidate) === parshaName) return candidate;
      d = new Date(d.getTime() + 7 * 86400000);
    }
    return null;
  }

  // ── DATE PICKER (English / Hebrew / Parsha) ─────────────────────

  function createDatePicker(container, initialIso) {
    container.innerHTML = '';
    const modes = el('div', 'date-modes');
    const panels = {};
    let currentIso = initialIso || '';

    ['English', 'Hebrew', 'Parsha'].forEach((label, i) => {
      const btn = el('button', 'date-mode-btn' + (i === 0 ? ' active' : ''), label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        modes.querySelectorAll('.date-mode-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        Object.values(panels).forEach((p) => p.classList.remove('active'));
        panels[label].classList.add('active');
      });
      modes.appendChild(btn);
    });
    container.appendChild(modes);

    const resolved = el('div', 'date-resolved', 'No date selected');
    function setResolved(iso) {
      currentIso = iso;
      resolved.textContent = iso ? `${iso} — ${hebrew.isoToHebrewString(iso)}` : 'No date selected';
    }

    // -- English panel --
    const engPanel = el('div', 'date-mode-panel active field-group');
    const engInput = el('input');
    engInput.type = 'date';
    engInput.addEventListener('change', () => setResolved(engInput.value));
    engPanel.appendChild(engInput);
    panels.English = engPanel;
    container.appendChild(engPanel);

    // -- Hebrew panel --
    const hebPanel = el('div', 'date-mode-panel field-group');
    const hebRow = el('div', 'field-row');
    const daySelect = el('select');
    const monthSelect = el('select');
    const yearInput = el('input');
    yearInput.type = 'number';
    yearInput.placeholder = 'Hebrew year e.g. 5786';
    yearInput.value = hebrew.currentHebrewYear();

    function populateHebrewDays() {
      const year = parseInt(yearInput.value, 10) || hebrew.currentHebrewYear();
      const month = parseInt(monthSelect.value, 10) || 1;
      const lengths = hebrew.monthLengths(year);
      const max = lengths[month - 1] || 30;
      daySelect.innerHTML = '';
      for (let d = 1; d <= max; d++) {
        const o = el('option', '', hebrew.dayToHebrew(d));
        o.value = d;
        daySelect.appendChild(o);
      }
    }
    function populateHebrewMonths() {
      const year = parseInt(yearInput.value, 10) || hebrew.currentHebrewYear();
      const names = hebrew.monthNames(year);
      monthSelect.innerHTML = '';
      names.forEach((name, i) => {
        const o = el('option', '', name);
        o.value = i + 1;
        monthSelect.appendChild(o);
      });
      populateHebrewDays();
    }
    function applyHebrew() {
      const year = parseInt(yearInput.value, 10);
      const month = parseInt(monthSelect.value, 10);
      const day = parseInt(daySelect.value, 10);
      if (year && month && day) setResolved(hebrew.hebrewToIso(year, month, day));
    }
    yearInput.addEventListener('input', () => { populateHebrewMonths(); applyHebrew(); });
    monthSelect.addEventListener('change', () => { populateHebrewDays(); applyHebrew(); });
    daySelect.addEventListener('change', applyHebrew);
    populateHebrewMonths();

    hebRow.appendChild(wrapLabeled('Day', daySelect));
    hebRow.appendChild(wrapLabeled('Month', monthSelect));
    hebRow.appendChild(wrapLabeled('Year', yearInput));
    hebPanel.appendChild(hebRow);
    panels.Hebrew = hebPanel;
    container.appendChild(hebPanel);

    // -- Parsha panel --
    const parshaPanel = el('div', 'date-mode-panel field-group');
    const parshaRow = el('div', 'field-row');
    const parshaSelect = el('select');
    (CFG.parshiyot || []).forEach((p) => {
      const name = CFG.combined[p] || p;
      const o = el('option', '', name);
      o.value = name;
      parshaSelect.appendChild(o);
    });
    const parshaYearInput = el('input');
    parshaYearInput.type = 'number';
    parshaYearInput.placeholder = 'Hebrew year e.g. 5786';
    parshaYearInput.value = hebrew.currentHebrewYear();

    function applyParsha() {
      const year = parseInt(parshaYearInput.value, 10);
      if (!year) return;
      const iso = parshaToIso(parshaSelect.value, year);
      if (iso) setResolved(iso);
    }
    parshaSelect.addEventListener('change', applyParsha);
    parshaYearInput.addEventListener('input', applyParsha);

    parshaRow.appendChild(wrapLabeled('Parsha', parshaSelect));
    parshaRow.appendChild(wrapLabeled('Year', parshaYearInput));
    parshaPanel.appendChild(parshaRow);
    panels.Parsha = parshaPanel;
    container.appendChild(parshaPanel);

    container.appendChild(resolved);

    if (initialIso) {
      engInput.value = initialIso;
      setResolved(initialIso);
    }

    function wrapLabeled(label, inputEl) {
      const wrap = el('div', 'field-group');
      wrap.appendChild(el('label', '', label));
      wrap.appendChild(inputEl);
      return wrap;
    }

    return {
      getIso: () => currentIso,
      setIso: (iso) => { engInput.value = iso || ''; setResolved(iso || ''); },
    };
  }

  // ── TAG PILLS ────────────────────────────────────────────────────

  function createTagInput(container, initialCsv) {
    container.innerHTML = '';
    let tags = (initialCsv || '').split(',').map((t) => t.trim()).filter(Boolean);

    const pillsEl = el('div', 'pills');
    const row = el('div', 'tag-input-row');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Add a tag and press Enter';
    const select = el('select');
    select.innerHTML = '<option value="">Existing tags…</option>';

    function render() {
      pillsEl.innerHTML = '';
      tags.forEach((t) => {
        const pill = el('span', 'pill', `${t} `);
        const rm = el('button', '', '&times;');
        rm.type = 'button';
        rm.addEventListener('click', () => { tags = tags.filter((x) => x !== t); render(); });
        pill.appendChild(rm);
        pillsEl.appendChild(pill);
      });
    }
    function add(value) {
      const v = value.trim();
      if (v && !tags.includes(v)) tags.push(v);
      render();
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(input.value); input.value = ''; }
    });
    select.addEventListener('change', () => { if (select.value) { add(select.value); select.value = ''; } });

    container.appendChild(pillsEl);
    row.appendChild(input);
    row.appendChild(select);
    container.appendChild(row);
    render();

    api.get('/api/tags').then(({ tags: existing }) => {
      existing.forEach((t) => {
        const o = el('option', '', t);
        o.value = t;
        select.appendChild(o);
      });
    }).catch(() => {});

    return { getValue: () => tags.join(', '), setValue: (csv) => { tags = (csv || '').split(',').map((t) => t.trim()).filter(Boolean); render(); } };
  }

  // ── CATEGORY INPUT ───────────────────────────────────────────────

  function createCategoryInput(container, initialValue) {
    container.innerHTML = '';
    const row = el('div', 'field-row');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Category';
    input.value = initialValue || '';
    const select = el('select');
    select.innerHTML = '<option value="">Existing categories…</option>';
    select.addEventListener('change', () => { if (select.value) { input.value = select.value; select.value = ''; } });

    row.appendChild(input);
    row.appendChild(select);
    container.appendChild(row);

    api.get('/api/categories').then(({ categories }) => {
      categories.forEach((c) => {
        const o = el('option', '', c);
        o.value = c;
        select.appendChild(o);
      });
    }).catch(() => {});

    return { getValue: () => input.value.trim(), setValue: (v) => { input.value = v || ''; } };
  }

  // ── GALLERY UPLOADER ─────────────────────────────────────────────
  // keyPrefix: R2 prefix new files upload under (e.g. "posts/1699999999")
  // existingFolder: existing folder_url to show + allow removing from

  function createGalleryUploader(container, { keyPrefix, existingFolder, accept } = {}) {
    container.innerHTML = '';
    let staged = []; // { file, name }
    // Already-uploaded files. Renaming/reordering these only edits this
    // local array — nothing hits the network until upload() runs (i.e.
    // Publish/Save changes), same as staged new files.
    let existingItems = []; // { originalKey, name }

    const existingListEl = el('ul', 'file-list');
    const dropzone = el('div', 'dropzone', 'Drag & drop files here, or click to choose');
    const sortRow = el('div', 'file-sort-row');
    const sortAZ = el('button', 'btn btn-sm', 'A→Z');
    const sortZA = el('button', 'btn btn-sm', 'Z→A');
    sortRow.appendChild(sortAZ);
    sortRow.appendChild(sortZA);
    const listEl = el('ul', 'file-list');
    const progress = el('div', 'progress-bar');
    const progressFill = el('div', 'progress-bar-fill');
    progress.appendChild(progressFill);
    const status = el('div', 'status-msg');

    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    if (accept) fileInput.accept = accept;

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      addFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

    function addFiles(fileList) {
      Array.from(fileList).forEach((file) => staged.push({ file, name: file.name }));
      renderStaged();
    }

    const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'];
    function isImageName(name) { return IMAGE_EXT.includes(String(name).split('.').pop().toLowerCase()); }

    // The rename input only ever edits the name; the extension is fixed
    // and re-appended automatically. Without this, renaming a file (e.g.
    // fixing a typo in a long Hebrew audio-track title) could drop the
    // ".mp3" by accident — the R2 key still renames "successfully", but
    // the public site's isAudio()/isImageName() extension check then no
    // longer recognizes it, so the track silently disappears from the
    // player despite the file still being right there in R2.
    function splitExt(name) {
      const m = String(name).match(/^(.+)\.([^.]+)$/);
      return m ? { base: m[1], ext: m[2] } : { base: name, ext: '' };
    }

    // Existing keys look like "prefix/0001-name.ext" — the zero-padded
    // index is what determines display order, so renaming or reordering
    // an already-uploaded file means renaming its R2 key in place.
    function parseKey(key) {
      const slash = key.lastIndexOf('/');
      const dir = key.slice(0, slash);
      const basename = key.slice(slash + 1);
      const m = basename.match(/^(\d{4})-(.+)$/);
      return m ? { dir, idx: m[1], name: m[2] } : { dir, idx: null, name: basename };
    }

    // The key an existing item WOULD have given its current position +
    // name — only actually renamed on the server at upload() time.
    function keyFor(item, position) {
      const { dir } = parseKey(item.originalKey);
      const idx = String(position + 1).padStart(4, '0');
      return `${dir}/${idx}-${sanitizeFilename(item.name)}`;
    }

    function renderExisting() {
      existingListEl.innerHTML = '';
      existingItems.forEach((item, i) => {
        const li = el('li');
        if (isImageName(item.originalKey)) {
          const thumb = el('img');
          thumb.src = api.r2Url(item.originalKey);
          thumb.className = 'file-thumb';
          li.appendChild(thumb);
        }

        // Rename is purely local (like staged files) until Publish/Save.
        // Editable base name only — the extension is fixed (see splitExt).
        const { base, ext } = splitExt(item.name);
        const nameInput = el('input');
        nameInput.type = 'text';
        nameInput.className = 'fname-input';
        nameInput.value = base;
        nameInput.title = 'Rename (applies when you save)';
        nameInput.addEventListener('input', () => { item.name = ext ? `${nameInput.value}.${ext}` : nameInput.value; });
        li.appendChild(nameInput);
        if (ext) li.appendChild(el('span', 'fname-ext', `.${ext}`));

        const up = el('button', '', '&#9650;');
        up.type = 'button';
        up.title = 'Move up';
        up.disabled = i === 0;
        up.addEventListener('click', () => {
          if (i > 0) { [existingItems[i - 1], existingItems[i]] = [existingItems[i], existingItems[i - 1]]; renderExisting(); }
        });
        const down = el('button', '', '&#9660;');
        down.type = 'button';
        down.title = 'Move down';
        down.disabled = i === existingItems.length - 1;
        down.addEventListener('click', () => {
          if (i < existingItems.length - 1) { [existingItems[i + 1], existingItems[i]] = [existingItems[i], existingItems[i + 1]]; renderExisting(); }
        });
        li.appendChild(up);
        li.appendChild(down);

        // Delete is the one immediate/permanent action here — same as
        // deleting a published post elsewhere in the admin.
        const rm = el('button', '', '&times;');
        rm.type = 'button';
        rm.title = 'Delete uploaded file';
        rm.addEventListener('click', async () => {
          rm.disabled = true;
          try {
            await api.del('/api/r2-delete', { key: item.originalKey });
            existingItems.splice(i, 1);
            renderExisting();
          } catch (e) {
            status.textContent = e.message || 'Could not delete file';
            status.className = 'status-msg err';
            rm.disabled = false;
          }
        });
        li.appendChild(rm);
        existingListEl.appendChild(li);
      });
    }

    function renderStaged() {
      listEl.innerHTML = '';
      staged.forEach((item, i) => {
        const li = el('li');
        if (isImageName(item.name) && item.file) {
          const thumb = el('img');
          thumb.className = 'file-thumb';
          thumb.src = URL.createObjectURL(item.file);
          li.appendChild(thumb);
        }
        // Rename only affects the staged (not-yet-uploaded) file — purely
        // local state until the form's own Publish/Save button uploads it.
        // Editable base name only — extension fixed, same as existing files.
        const { base: stagedBase, ext: stagedExt } = splitExt(item.name);
        const nameInput = el('input');
        nameInput.type = 'text';
        nameInput.className = 'fname-input';
        nameInput.value = stagedBase;
        nameInput.title = 'Rename before uploading';
        nameInput.addEventListener('input', () => { item.name = stagedExt ? `${nameInput.value}.${stagedExt}` : nameInput.value; });
        li.appendChild(nameInput);
        if (stagedExt) li.appendChild(el('span', 'fname-ext', `.${stagedExt}`));

        const up = el('button', '', '&#9650;');
        up.type = 'button';
        up.title = 'Move up';
        up.addEventListener('click', () => { if (i > 0) { [staged[i - 1], staged[i]] = [staged[i], staged[i - 1]]; renderStaged(); } });
        const down = el('button', '', '&#9660;');
        down.type = 'button';
        down.title = 'Move down';
        down.addEventListener('click', () => { if (i < staged.length - 1) { [staged[i + 1], staged[i]] = [staged[i], staged[i + 1]]; renderStaged(); } });
        const rm = el('button', '', '&times;');
        rm.type = 'button';
        rm.title = 'Remove';
        rm.addEventListener('click', () => { staged.splice(i, 1); renderStaged(); });
        li.appendChild(up);
        li.appendChild(down);
        li.appendChild(rm);
        listEl.appendChild(li);
      });
    }
    sortAZ.addEventListener('click', () => { staged.sort((a, b) => a.name.localeCompare(b.name)); renderStaged(); });
    sortZA.addEventListener('click', () => { staged.sort((a, b) => b.name.localeCompare(a.name)); renderStaged(); });

    // upload() awaits this before touching existingItems.length — without
    // it, saving quickly after opening Edit (before this fetch resolves)
    // would upload new files starting at index 0001, colliding with and
    // silently overwriting whichever existing file already sits at that
    // key in R2 (a PUT to an occupied key just replaces it, no error).
    let existingLoadPromise = Promise.resolve();
    if (existingFolder) {
      status.textContent = 'Loading existing files…';
      existingLoadPromise = api.listFolder(existingFolder).then((keys) => {
        existingItems = keys.map((key) => ({ originalKey: key, name: parseKey(key).name }));
        status.textContent = '';
        renderExisting();
      }).catch(() => { status.textContent = ''; });
    }

    container.appendChild(el('label', '', 'Existing files'));
    container.appendChild(existingListEl);
    container.appendChild(el('label', '', 'Add files'));
    container.appendChild(dropzone);
    container.appendChild(fileInput);
    container.appendChild(sortRow);
    container.appendChild(listEl);
    container.appendChild(progress);
    container.appendChild(status);

    async function upload(finalPrefix) {
      await existingLoadPromise;
      const prefix = existingFolder || finalPrefix || keyPrefix;

      // Apply any pending rename/reorder of existing files first — this
      // is the point where those local edits finally hit the network.
      for (let i = 0; i < existingItems.length; i++) {
        const item = existingItems[i];
        const newKey = keyFor(item, i);
        if (newKey !== item.originalKey) {
          status.textContent = 'Saving file changes…';
          status.className = 'status-msg';
          await api.renameFile(item.originalKey, newKey);
          item.originalKey = newKey;
        }
      }

      if (staged.length) {
        progress.style.display = 'block';
        const startIndex = existingItems.length;
        for (let i = 0; i < staged.length; i++) {
          const idx = String(startIndex + i + 1).padStart(4, '0');
          const key = `${prefix}/${idx}-${sanitizeFilename(staged[i].name)}`;
          status.className = 'status-msg';
          await api.uploadFile(key, staged[i].file, (frac) => {
            status.textContent = `Uploading file ${i + 1} / ${staged.length} (${Math.round(frac * 100)}%)…`;
          });
          progressFill.style.width = `${Math.round(((i + 1) / staged.length) * 100)}%`;
        }
        status.textContent = 'Upload complete.';
        status.className = 'status-msg ok';
      } else {
        status.textContent = '';
      }
      return prefix;
    }

    return { upload, hasStaged: () => staged.length > 0 };
  }

  return { createDatePicker, createTagInput, createCategoryInput, createGalleryUploader, sanitizeFilename, parshaToIso };
})();
