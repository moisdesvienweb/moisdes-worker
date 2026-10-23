// ================================================================
// MOISDES ADMIN — Upload panel (also powers the Browse & Edit modal)
// admin-upload.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminUpload = (function () {
  const api = window.MOISDES.api;
  const AF = window.MOISDES.adminFields;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    // See admin-fields.js's el() for why: a type-less <button> defaults
    // to submit and silently fires the surrounding <form> on click. The
    // one real submit button (below) explicitly opts back in.
    if (tag === 'button') e.type = 'button';
    return e;
  }
  function fieldGroup(labelText, inputEl) {
    const g = el('div', 'field-group');
    g.appendChild(el('label', '', labelText));
    g.appendChild(inputEl);
    return g;
  }
  function textInput(placeholder, value) {
    const i = el('input');
    i.type = 'text';
    if (placeholder) i.placeholder = placeholder;
    if (value) i.value = value;
    return i;
  }
  function textarea(placeholder, value) {
    const t = el('textarea');
    if (placeholder) t.placeholder = placeholder;
    if (value) t.value = value;
    return t;
  }
  // Rich-text (bold/italic/underline/font/size/alignment/RTL-LTR) field
  // for "description"-style content — replaces a plain textarea. Returns
  // the wrapped <div class="field-group"> to append, plus the editor
  // object (.getHtml() used at submit time instead of reading .value).
  function richTextField(labelText, initialHtml) {
    const host = el('div');
    const editor = window.MOISDES.richtext.createEditor(host, initialHtml || '');
    return { group: fieldGroup(labelText, host), editor };
  }
  function statusEl() { return el('div', 'status-msg'); }
  function setStatus(node, message, ok) {
    node.textContent = message;
    node.className = 'status-msg' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  // Plain text input that upgrades itself to Google address suggestions
  // once a Maps API key is configured in Settings — degrades to a normal
  // free-text location field (no error) when no key is set yet.
  //
  // This calls the Places API "Autocomplete (New)" REST endpoint directly
  // with fetch() and renders its own dropdown, rather than loading
  // Google's Maps JavaScript API and using its `google.maps.places.
  // Autocomplete` widget — that legacy widget stopped being issued to API
  // keys created after March 2025, so it silently never attaches for any
  // key made after that (which is exactly why it looked broken). The
  // REST endpoint it calls instead works for every key, old or new.
  function locationAutocompleteInput(initialValue) {
    const wrap = el('div', 'location-autocomplete');
    const input = textInput('Start typing an address…', initialValue);
    wrap.appendChild(input);
    const suggestionsEl = el('div', 'location-suggestions');
    wrap.appendChild(suggestionsEl);
    const hint = el('div', 'state-msg', '');
    wrap.appendChild(hint);

    let apiKey = null;
    api.get('/api/settings').then(({ settings }) => {
      apiKey = settings.gmaps_api_key || null;
      if (!apiKey) hint.textContent = 'Tip: add a Google Maps API key in Settings to get address suggestions here.';
    }).catch(() => {});

    function hideSuggestions() { suggestionsEl.style.display = 'none'; suggestionsEl.innerHTML = ''; }

    async function fetchSuggestions(text) {
      if (!apiKey || !text.trim()) { hideSuggestions(); return; }
      try {
        const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
          body: JSON.stringify({ input: text }),
        });
        const data = await res.json().catch(() => ({}));
        const items = (data.suggestions || []).map((s) => s.placePrediction?.text?.text).filter(Boolean);
        if (!items.length) { hideSuggestions(); return; }
        suggestionsEl.innerHTML = '';
        items.forEach((text) => {
          const item = document.createElement('div');
          item.className = 'location-suggestion-item';
          item.textContent = text;
          // mousedown (not click) fires before the input's blur, so the
          // suggestion is still in the DOM to be clicked.
          item.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = text; hideSuggestions(); });
          suggestionsEl.appendChild(item);
        });
        suggestionsEl.style.display = 'block';
      } catch (e) { hideSuggestions(); }
    }

    let debounceTimer;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchSuggestions(input.value), 300);
    });
    input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

    return { wrap, getValue: () => input.value.trim() };
  }

  // Parsha field uses AF.createParshaPicker (pill-select + add-new) now —
  // see admin-fields.js.

  // Same free-text-input + "pick an existing one" dropdown pattern as
  // AF.createCategoryInput, but for PDF issue years — existing years are
  // pulled from the already-published PDFs (no dedicated backend table
  // needed, since years live directly on the pdfs rows). Picking an
  // existing year still doesn't block typing a new one.
  function yearInput(initialValue) {
    const row = el('div', 'field-row');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Issue year / number';
    input.value = initialValue || '';
    const select = el('select');
    select.innerHTML = '<option value="">Existing years…</option>';
    select.addEventListener('change', () => { if (select.value) { input.value = select.value; select.value = ''; } });
    row.appendChild(input);
    row.appendChild(select);

    api.get('/api/pdfs').then(({ pdfs }) => {
      const years = [...new Set((pdfs || []).map((p) => p.year).filter(Boolean))].sort((a, b) => {
        const na = parseFloat(a), nb = parseFloat(b);
        if (!isNaN(na) && !isNaN(nb)) return nb - na;
        return String(b).localeCompare(String(a));
      });
      years.forEach((y) => {
        const o = el('option', '', y);
        o.value = y;
        select.appendChild(o);
      });
    }).catch(() => {});

    return { row, getValue: () => input.value.trim() };
  }

  // ── FORM BUILDER — shared by "Upload" (create) and "Browse & Edit" (edit) ──
  //
  // opts: { existing, onSaved }
  //   existing: the record being edited (omit for create mode)
  //   onSaved:  called after a successful save (edit mode only)

  function buildForm(type, container, opts = {}) {
    const existing = opts.existing || null;
    const isEdit = !!existing;
    // Duplicating: opts.prefill supplies the same text/metadata fields as
    // an edit would, but isEdit stays false (this is a fresh Publish) and
    // nothing R2-file-related (gallery, thumbnail, PDF, video file) is
    // carried over — those always come from `existing` only, so a
    // duplicate never shares files with (or can delete files from) the
    // item it was copied from.
    const prefillSrc = existing || opts.prefill || null;

    container.innerHTML = '';
    const form = el('form');
    const status = statusEl();

    // Pressing Enter in any plain text field natively submits the form —
    // this is almost certainly what's been reported as files "uploading"
    // or the record saving before the Publish/Save button is clicked.
    // Only an actual click (or Enter while focused on the submit button
    // itself) should submit. A rich-text body/description field is a
    // contenteditable <div>, not a <textarea> — excluded here too, since
    // otherwise this same guard was swallowing Enter inside it and
    // silently blocking new lines/paragraphs from ever being typed.
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit' && !e.target.isContentEditable) {
        e.preventDefault();
      }
    });

    // PDFs in create mode use a per-file date picker inside each batch
    // card instead (see below) — one shared date wouldn't make sense
    // once multiple PDFs, each wanting its own date, are involved.
    // The Calendar tab has its own start/end date pickers below (a date
    // range, not a single date) — same reasoning as the PDF batch-create
    // exclusion just above.
    const isPdfBatchCreate = type === 'pdfs' && !isEdit;
    const isCalendarCreate = type === 'calendar';
    const datePickerWrap = el('div');
    if (!isPdfBatchCreate && !isCalendarCreate) form.appendChild(fieldGroup(type === 'simchas' ? 'Date added' : 'Date', datePickerWrap));
    const datePicker = AF.createDatePicker(datePickerWrap, prefillSrc ? (prefillSrc.date || prefillSrc.date_added || '').slice(0, 10) : '');

    let getExtra;
    let gallery;
    let tagInput, categoryInput;

    if (type === 'posts') {
      const title = textInput('Title', prefillSrc?.title);
      form.appendChild(fieldGroup('Title', title));
      const bodyField = richTextField('Text', prefillSrc?.body);
      form.appendChild(bodyField.group);

      const catWrap = el('div');
      form.appendChild(fieldGroup('Category', catWrap));
      categoryInput = AF.createCategoryInput(catWrap, prefillSrc?.category);

      const tagWrap = el('div');
      form.appendChild(fieldGroup('Tags', tagWrap));
      tagInput = AF.createTagInput(tagWrap, prefillSrc?.tags);

      const galleryWrap = el('div');
      form.appendChild(fieldGroup('Images', galleryWrap));
      gallery = AF.createGalleryUploader(galleryWrap, { accept: 'image/*', existingFolder: existing?.folder_url });

      // Featured posts take over the home page's big slot as a rotating
      // slideshow instead of just the single newest post — any number can
      // be marked, nothing special happens until at least one is.
      const featuredRow = el('div', 'checkbox-row');
      const featuredCheckbox = el('input');
      featuredCheckbox.type = 'checkbox';
      featuredCheckbox.id = 'post-featured';
      featuredCheckbox.checked = !!(prefillSrc && Number(prefillSrc.featured));
      const featuredLabel = el('label', '', 'Featured (shows in the home page\'s rotating spotlight)');
      featuredLabel.htmlFor = featuredCheckbox.id;
      featuredLabel.style.margin = '0';
      featuredRow.appendChild(featuredCheckbox);
      featuredRow.appendChild(featuredLabel);
      form.appendChild(fieldGroup('', featuredRow));

      getExtra = () => ({ title: title.value, body: bodyField.editor.getHtml(), category: categoryInput.getValue(), tags: tagInput.getValue(), featured: featuredCheckbox.checked ? 1 : 0 });

    } else if (type === 'posters') {
      const parshaWrap = el('div');
      const parshaPicker = AF.createParshaPicker(parshaWrap, prefillSrc?.parsha);
      form.appendChild(fieldGroup('Parsha', parshaWrap));

      const galleryWrap = el('div');
      form.appendChild(fieldGroup('Images', galleryWrap));
      gallery = AF.createGalleryUploader(galleryWrap, { accept: 'image/*', existingFolder: existing?.folder_url });

      getExtra = () => ({ parsha: parshaPicker.getValue() });

    } else if (type === 'events') {
      const title = textInput('Title', prefillSrc?.title);
      form.appendChild(fieldGroup('Title', title));
      const location = textInput('Location', prefillSrc?.location);
      form.appendChild(fieldGroup('Location', location));

      const catWrap = el('div');
      form.appendChild(fieldGroup('Category', catWrap));
      categoryInput = AF.createCategoryInput(catWrap, prefillSrc?.category);

      const descriptionField = richTextField('Description', prefillSrc?.description);
      form.appendChild(descriptionField.group);

      const tagWrap = el('div');
      form.appendChild(fieldGroup('Tags', tagWrap));
      tagInput = AF.createTagInput(tagWrap, prefillSrc?.tags);

      // Thumbnail — separate from the photos/audio gallery below, this is
      // what shows on the home page and anywhere else a single preview
      // image is needed.
      let eventThumbFile = null, eventThumbFileName = '';
      const eventThumbNote = existing?.thumb_url ? el('div', 'state-msg', `Current thumbnail: ${existing.thumb_url.split('/').pop()}`) : null;
      if (eventThumbNote) form.appendChild(eventThumbNote);
      const eventThumbWrap = el('div');
      const eventThumbInput = el('input');
      eventThumbInput.type = 'file';
      eventThumbInput.accept = 'image/*';
      eventThumbWrap.appendChild(eventThumbInput);
      const eventThumbPreview = el('div');
      eventThumbPreview.style.margin = '.5rem 0';
      eventThumbWrap.appendChild(eventThumbPreview);
      const eventThumbNameWrap = el('div');
      const eventThumbNameInput = textInput('File name');
      eventThumbNameWrap.style.display = 'none';
      eventThumbNameWrap.appendChild(eventThumbNameInput);
      eventThumbWrap.appendChild(eventThumbNameWrap);
      eventThumbInput.addEventListener('change', () => {
        const file = eventThumbInput.files[0];
        if (!file) return;
        eventThumbFile = file;
        eventThumbFileName = file.name;
        eventThumbNameInput.value = eventThumbFileName;
        eventThumbNameWrap.style.display = 'block';
        eventThumbPreview.innerHTML = '';
        const img = el('img');
        img.src = URL.createObjectURL(file);
        img.style.maxWidth = '140px';
        img.style.borderRadius = '4px';
        eventThumbPreview.appendChild(img);
      });
      eventThumbNameInput.addEventListener('input', () => { eventThumbFileName = eventThumbNameInput.value; });
      form.appendChild(fieldGroup(isEdit ? 'Replace thumbnail (optional)' : 'Thumbnail (optional)', eventThumbWrap));

      const galleryWrap = el('div');
      form.appendChild(fieldGroup('Photos & audio', galleryWrap));
      gallery = AF.createGalleryUploader(galleryWrap, { existingFolder: existing?.folder_url });

      getExtra = () => ({ title: title.value, location: location.value, category: categoryInput.getValue(), description: descriptionField.editor.getHtml(), tags: tagInput.getValue() });
      form._getEventThumb = () => (eventThumbFile ? { file: eventThumbFile, name: eventThumbFileName } : null);

    } else if (type === 'videos') {
      const title = textInput('Title', prefillSrc?.title);
      form.appendChild(fieldGroup('Title', title));
      const location = textInput('Location', prefillSrc?.location);
      form.appendChild(fieldGroup('Location', location));

      const catWrap = el('div');
      form.appendChild(fieldGroup('Category', catWrap));
      categoryInput = AF.createCategoryInput(catWrap, prefillSrc?.category);

      const descriptionField = richTextField('Description', prefillSrc?.description);
      form.appendChild(descriptionField.group);

      const videoUrl = textInput('https://youtube.com/watch?v=... (optional)', prefillSrc?.video_url);
      form.appendChild(fieldGroup('YouTube URL (optional)', videoUrl));

      // Uploading the file directly plays it with a plain <video> tag —
      // no YouTube branding at all — and takes priority over the YouTube
      // URL above if both are set. Only upload files you have the rights
      // to host yourself.
      let videoFile = null, videoFileName = '';
      const videoFileNote = existing?.video_file_url ? el('div', 'state-msg', `Current file: ${existing.video_file_url.split('/').pop()}`) : null;
      if (videoFileNote) form.appendChild(videoFileNote);
      const videoFileWrap = el('div');
      const videoFileInput = el('input');
      videoFileInput.type = 'file';
      videoFileInput.accept = 'video/*';
      videoFileWrap.appendChild(videoFileInput);
      const videoFileNameWrap = el('div');
      const videoFileNameInput = textInput('File name');
      videoFileNameWrap.style.display = 'none';
      videoFileNameWrap.appendChild(videoFileNameInput);
      videoFileWrap.appendChild(videoFileNameWrap);
      videoFileInput.addEventListener('change', () => {
        const file = videoFileInput.files[0];
        if (!file) return;
        videoFile = file;
        videoFileName = file.name;
        videoFileNameInput.value = videoFileName;
        videoFileNameWrap.style.display = 'block';
      });
      videoFileNameInput.addEventListener('input', () => { videoFileName = videoFileNameInput.value; });
      form.appendChild(fieldGroup(isEdit ? 'Replace video file (optional, no YouTube branding)' : 'Video file (optional, no YouTube branding)', videoFileWrap));

      const tagWrap = el('div');
      form.appendChild(fieldGroup('Tags', tagWrap));
      tagInput = AF.createTagInput(tagWrap, prefillSrc?.tags);

      const galleryWrap = el('div');
      form.appendChild(fieldGroup('Extra images (optional)', galleryWrap));
      gallery = AF.createGalleryUploader(galleryWrap, { accept: 'image/*', existingFolder: existing?.folder_url });

      getExtra = () => ({ title: title.value, location: location.value, category: categoryInput.getValue(), description: descriptionField.editor.getHtml(), video_url: videoUrl.value, tags: tagInput.getValue() });
      form._getVideoFile = () => (videoFile ? { file: videoFile, name: videoFileName } : null);

    } else if (type === 'pdfs' && isEdit) {
      const title = textInput('Title', prefillSrc?.title);
      form.appendChild(fieldGroup('Title', title));

      const catWrap = el('div');
      form.appendChild(fieldGroup('Category', catWrap));
      categoryInput = AF.createCategoryInput(catWrap, prefillSrc?.category);

      const languageWrap = el('div');
      const languagePicker = AF.createLanguagePicker(languageWrap, prefillSrc?.language);
      form.appendChild(fieldGroup('Language', languageWrap));

      const parshaWrap = el('div');
      const parshaPicker = AF.createParshaPicker(parshaWrap, prefillSrc?.parsha);
      form.appendChild(fieldGroup('Parsha', parshaWrap));

      const year = yearInput(prefillSrc?.year);
      form.appendChild(fieldGroup('Year', year.row));

      // PDF file — picking one auto-generates a cover thumbnail from its
      // first page (via pdf.js) and lets the filename be renamed before
      // anything actually uploads.
      let pdfFile = null, pdfFileName = '';
      let autoThumbBlob = null, manualThumbFile = null, manualThumbFileName = '';

      const pdfNote = existing?.pdf_url ? el('div', 'state-msg', `Current file: ${existing.pdf_url.split('/').pop()}`) : null;
      if (pdfNote) form.appendChild(pdfNote);
      const pdfFileWrap = el('div');
      const pdfFileInput = el('input');
      pdfFileInput.type = 'file';
      pdfFileInput.accept = 'application/pdf';
      pdfFileWrap.appendChild(pdfFileInput);
      const pdfNameWrap = el('div');
      const pdfNameInput = textInput('File name');
      pdfNameWrap.style.display = 'none';
      pdfNameWrap.appendChild(pdfNameInput);
      pdfFileWrap.appendChild(pdfNameWrap);
      form.appendChild(fieldGroup('Replace PDF file (optional)', pdfFileWrap));

      const thumbPreviewWrap = el('div');
      thumbPreviewWrap.style.margin = '0 0 .75rem';
      form.appendChild(thumbPreviewWrap);

      function renderThumbPreview(src, label) {
        thumbPreviewWrap.innerHTML = '';
        if (src) {
          const img = el('img');
          img.src = src;
          img.style.maxWidth = '140px';
          img.style.borderRadius = '4px';
          img.style.marginBottom = '.4rem';
          thumbPreviewWrap.appendChild(img);
        }
        if (label) thumbPreviewWrap.appendChild(el('div', 'state-msg', label));
      }

      pdfFileInput.addEventListener('change', async () => {
        const file = pdfFileInput.files[0];
        if (!file) return;
        pdfFile = file;
        pdfFileName = file.name;
        pdfNameInput.value = pdfFileName;
        pdfNameWrap.style.display = 'block';

        if (!window.pdfjsLib) {
          renderThumbPreview(null, 'Thumbnail auto-generation unavailable — pick one manually below.');
          return;
        }
        renderThumbPreview(null, 'Generating thumbnail from page 1…');
        try {
          const buf = await file.arrayBuffer();
          const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 1.4 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          autoThumbBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (!manualThumbFile) renderThumbPreview(canvas.toDataURL('image/png'), 'Auto-generated thumbnail (replace below if you\'d like a different one).');
        } catch (e) {
          renderThumbPreview(null, 'Could not auto-generate a thumbnail — pick one manually below.');
        }
      });
      pdfNameInput.addEventListener('input', () => { pdfFileName = pdfNameInput.value; });

      const thumbNote = existing?.thumb_url ? el('div', 'state-msg', `Current thumbnail: ${existing.thumb_url.split('/').pop()}`) : null;
      if (thumbNote) form.appendChild(thumbNote);
      const thumbWrap = el('div');
      const thumbInput = el('input');
      thumbInput.type = 'file';
      thumbInput.accept = 'image/*';
      thumbWrap.appendChild(thumbInput);
      const thumbNameWrap = el('div');
      const thumbNameInput = textInput('File name');
      thumbNameWrap.style.display = 'none';
      thumbNameWrap.appendChild(thumbNameInput);
      thumbWrap.appendChild(thumbNameWrap);
      form.appendChild(fieldGroup('Replace thumbnail (optional)', thumbWrap));

      thumbInput.addEventListener('change', () => {
        const file = thumbInput.files[0];
        if (!file) return;
        manualThumbFile = file;
        manualThumbFileName = file.name;
        thumbNameInput.value = manualThumbFileName;
        thumbNameWrap.style.display = 'block';
        renderThumbPreview(URL.createObjectURL(file), 'Manually chosen thumbnail.');
      });
      thumbNameInput.addEventListener('input', () => { manualThumbFileName = thumbNameInput.value; });

      getExtra = () => ({ title: title.value, category: categoryInput.getValue(), language: languagePicker.getValue(), parsha: parshaPicker.getValue(), year: year.getValue() });

      form._getPdfFile = () => ({ file: pdfFile, name: pdfFileName });
      form._getThumb = () => manualThumbFile
        ? { file: manualThumbFile, name: manualThumbFileName }
        : (autoThumbBlob ? { file: autoThumbBlob, name: 'cover.png' } : null);

    } else if (type === 'pdfs' && !isEdit) {
      // Batch create — pick any number of PDFs; each gets its own card
      // below with fully independent date/title/category/language/
      // parsha/year/thumbnail, and becomes its own separate post. A
      // single file still works fine here — it's just a batch of one.
      const cards = [];

      const pickerWrap = el('div');
      const filesInput = el('input');
      filesInput.type = 'file';
      filesInput.accept = 'application/pdf';
      filesInput.multiple = true;
      pickerWrap.appendChild(filesInput);
      form.appendChild(fieldGroup('PDF file(s) — pick one or more; each becomes its own post below', pickerWrap));

      const cardsWrap = el('div');
      form.appendChild(cardsWrap);

      function buildPdfCard(file) {
        const card = el('div', 'pdf-batch-card');
        const cardHead = el('div', 'pdf-batch-card-head');
        cardHead.textContent = file.name;
        card.appendChild(cardHead);

        const dateWrap = el('div');
        card.appendChild(fieldGroup('Date', dateWrap));
        const cardDatePicker = AF.createDatePicker(dateWrap, '');

        const titleInput = textInput('Title', file.name.replace(/\.pdf$/i, ''));
        card.appendChild(fieldGroup('Title', titleInput));

        const catWrap = el('div');
        card.appendChild(fieldGroup('Category', catWrap));
        const cardCategoryInput = AF.createCategoryInput(catWrap, '');

        const languageWrap = el('div');
        card.appendChild(fieldGroup('Language', languageWrap));
        const cardLanguagePicker = AF.createLanguagePicker(languageWrap, '');

        const parshaWrap = el('div');
        card.appendChild(fieldGroup('Parsha', parshaWrap));
        const cardParshaPicker = AF.createParshaPicker(parshaWrap, '');

        const cardYear = yearInput('');
        card.appendChild(fieldGroup('Year', cardYear.row));

        let autoThumbBlob = null, manualThumbFile = null, manualThumbFileName = '';
        const thumbPreviewWrap = el('div');
        thumbPreviewWrap.style.margin = '0 0 .6rem';
        card.appendChild(thumbPreviewWrap);
        function renderThumbPreview(src, label) {
          thumbPreviewWrap.innerHTML = '';
          if (src) {
            const img = el('img');
            img.src = src;
            img.style.cssText = 'max-width:100px;border-radius:4px;margin-bottom:.3rem;display:block';
            thumbPreviewWrap.appendChild(img);
          }
          if (label) thumbPreviewWrap.appendChild(el('div', 'state-msg', label));
        }
        if (window.pdfjsLib) {
          renderThumbPreview(null, 'Generating thumbnail…');
          file.arrayBuffer().then(async (buf) => {
            try {
              const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
              const page = await pdf.getPage(1);
              const viewport = page.getViewport({ scale: 1.2 });
              const canvas = document.createElement('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
              autoThumbBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
              if (!manualThumbFile) renderThumbPreview(canvas.toDataURL('image/png'), 'Auto-generated (replace below if you’d like).');
            } catch (e) {
              renderThumbPreview(null, 'Could not auto-generate a thumbnail — pick one manually below.');
            }
          });
        } else {
          renderThumbPreview(null, 'Thumbnail auto-generation unavailable — pick one manually below.');
        }

        const thumbInput = el('input');
        thumbInput.type = 'file';
        thumbInput.accept = 'image/*';
        card.appendChild(fieldGroup('Cover thumbnail (optional)', thumbInput));
        thumbInput.addEventListener('change', () => {
          const f = thumbInput.files[0];
          if (!f) return;
          manualThumbFile = f;
          manualThumbFileName = f.name;
          renderThumbPreview(URL.createObjectURL(f), 'Manually chosen thumbnail.');
        });

        const cardStatus = statusEl();
        card.appendChild(cardStatus);

        const removeBtn = el('button', 'btn btn-sm btn-danger', 'Remove this file');
        removeBtn.addEventListener('click', () => {
          const idx = cards.indexOf(entry);
          if (idx !== -1) cards.splice(idx, 1);
          card.remove();
        });
        card.appendChild(removeBtn);

        const entry = {
          card, cardStatus,
          getPayload: () => ({
            date: cardDatePicker.getIso(),
            title: titleInput.value,
            category: cardCategoryInput.getValue(),
            language: cardLanguagePicker.getValue(),
            parsha: cardParshaPicker.getValue(),
            year: cardYear.getValue(),
          }),
          getPdfFile: () => ({ file, name: file.name }),
          getThumb: () => manualThumbFile
            ? { file: manualThumbFile, name: manualThumbFileName }
            : (autoThumbBlob ? { file: autoThumbBlob, name: 'cover.png' } : null),
        };
        return entry;
      }

      filesInput.addEventListener('change', () => {
        Array.from(filesInput.files).forEach((file) => {
          const entry = buildPdfCard(file);
          cards.push(entry);
          cardsWrap.appendChild(entry.card);
        });
        filesInput.value = ''; // lets the same file be re-added if removed, and keeps already-built cards when adding more
      });

      form._pdfCards = cards;

    } else if (type === 'simchas') {
      const text = textarea('Simcha (e.g. names + occasion)', prefillSrc?.text);
      form.appendChild(fieldGroup('Text', text));
      getExtra = () => ({ text: text.value });

    } else if (type === 'calendar') {
      // Writes a real event straight to the admin's Google Calendar (via
      // the Worker's service-account credentials) — this isn't a site
      // content type and has no local record, so there's nothing to
      // browse/edit here afterward; manage it in Google Calendar itself.
      const title = textInput('Event title', '');
      form.appendChild(fieldGroup('Title', title));

      const startDateWrap = el('div');
      form.appendChild(fieldGroup('Start date', startDateWrap));
      const startDatePicker = AF.createDatePicker(startDateWrap, '');

      const endDateWrap = el('div');
      form.appendChild(fieldGroup('End date (same as start for a one-day event)', endDateWrap));
      const endDatePicker = AF.createDatePicker(endDateWrap, '');

      const timeRow = el('div', 'field-row');
      const startTime = el('input');
      startTime.type = 'time';
      const endTime = el('input');
      endTime.type = 'time';
      timeRow.appendChild(startTime);
      timeRow.appendChild(endTime);
      form.appendChild(fieldGroup('Start / end time (leave both blank for an all-day event)', timeRow));

      const locationField = locationAutocompleteInput('');
      form.appendChild(fieldGroup('Location', locationField.wrap));

      const descField = richTextField('Description', '');
      form.appendChild(descField.group);

      getExtra = () => ({
        title: title.value.trim(),
        startDate: startDatePicker.getIso(),
        endDate: endDatePicker.getIso() || startDatePicker.getIso(),
        startTime: startTime.value,
        endTime: endTime.value,
        location: locationField.getValue(),
        description: descField.editor.getHtml(),
      });
    }

    const submitBtn = el('button', 'btn btn-primary', isEdit ? 'Save changes' : (type === 'calendar' ? 'Create event' : 'Publish'));
    submitBtn.type = 'submit';
    form.appendChild(submitBtn);
    form.appendChild(status);
    container.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;

      // Batch PDF create — entirely separate flow: one card per file,
      // each uploaded and published independently (in parallel) instead
      // of the single shared date/payload path below.
      if (type === 'pdfs' && !isEdit) {
        if (!form._pdfCards.length) {
          setStatus(status, 'Please choose at least one PDF file.', false);
          submitBtn.disabled = false;
          return;
        }
        setStatus(status, `Publishing ${form._pdfCards.length} PDF${form._pdfCards.length > 1 ? 's' : ''}…`);
        const results = await Promise.all(form._pdfCards.map(async (entry) => {
          try {
            const payload = entry.getPayload();
            if (!payload.date) throw new Error('Please choose a date for every file.');
            const { file: pdfFile, name: pdfName } = entry.getPdfFile();
            const thumb = entry.getThumb();
            const pdfKey = `pdfs/${Date.now()}-${AF.sanitizeFilename(pdfName)}`;
            const thumbKey = thumb ? `pdfs/${Date.now()}-thumb-${AF.sanitizeFilename(thumb.name)}` : null;
            setStatus(entry.cardStatus, 'Uploading…');
            await Promise.all([
              api.uploadFile(pdfKey, pdfFile),
              thumbKey ? api.uploadFile(thumbKey, thumb.file) : null,
            ]);
            payload.pdf_url = pdfKey;
            payload.thumb_url = thumbKey || undefined;
            await api.post('/api/pdfs', payload);
            setStatus(entry.cardStatus, 'Published.', true);
            return { ok: true };
          } catch (err) {
            setStatus(entry.cardStatus, err.message || 'Failed.', false);
            return { ok: false };
          }
        }));
        const okCount = results.filter((r) => r.ok).length;
        if (okCount === form._pdfCards.length) {
          setStatus(status, `Published ${okCount} PDF${okCount > 1 ? 's' : ''} successfully.`, true);
          buildForm(type, container);
        } else {
          setStatus(status, `Published ${okCount} of ${form._pdfCards.length} — see each card above for what failed.`, false);
          submitBtn.disabled = false;
        }
        return;
      }

      // Calendar — a one-shot write straight to Google Calendar, nothing
      // saved locally, so it skips the whole date/payload/R2 flow below.
      if (type === 'calendar') {
        try {
          const extra = getExtra();
          if (!extra.title) throw new Error('Please enter a title.');
          if (!extra.startDate) throw new Error('Please choose a start date.');
          setStatus(status, 'Creating calendar event…');
          await api.post('/api/gcal-events', extra);
          setStatus(status, 'Event created in Google Calendar.', true);
          buildForm(type, container);
        } catch (err) {
          setStatus(status, err.message || 'Something went wrong.', false);
          submitBtn.disabled = false;
        }
        return;
      }

      setStatus(status, 'Saving…');

      try {
        const date = datePicker.getIso();
        if (!date) throw new Error('Please choose a date.');
        const payload = type === 'simchas' ? { date_added: date, ...getExtra() } : { date, ...getExtra() };

        if (type === 'pdfs') {
          const { file: pdfFile, name: pdfName } = form._getPdfFile();
          const thumb = form._getThumb();
          if (!isEdit && !pdfFile) throw new Error('Please choose a PDF file.');
          const pdfKey = pdfFile ? `pdfs/${Date.now()}-${AF.sanitizeFilename(pdfName || pdfFile.name)}` : null;
          const thumbKey = thumb ? `pdfs/${Date.now()}-thumb-${AF.sanitizeFilename(thumb.name)}` : null;
          // The PDF and its thumbnail are independent uploads — run them
          // together instead of waiting on one before starting the other.
          await Promise.all([
            pdfKey ? api.uploadFile(pdfKey, pdfFile) : null,
            thumbKey ? api.uploadFile(thumbKey, thumb.file) : null,
          ]);
          payload.pdf_url = pdfKey || (isEdit ? existing.pdf_url || '' : undefined);
          payload.thumb_url = thumbKey || (isEdit ? existing.thumb_url || '' : undefined);
        } else if (gallery) {
          const prefix = existing?.folder_url || `${type}/${Date.now()}`;
          const folder = await gallery.upload(prefix);
          payload.folder_url = folder || existing?.folder_url || '';
        }

        if (type === 'events') {
          const thumb = form._getEventThumb();
          if (thumb) {
            const thumbKey = `events/${Date.now()}-thumb-${AF.sanitizeFilename(thumb.name)}`;
            await api.uploadFile(thumbKey, thumb.file);
            payload.thumb_url = thumbKey;
          } else if (isEdit) {
            payload.thumb_url = existing.thumb_url || '';
          }
        }

        if (type === 'videos') {
          const videoFile = form._getVideoFile();
          if (videoFile) {
            const fileKey = `videos/${Date.now()}-${AF.sanitizeFilename(videoFile.name)}`;
            await api.uploadFile(fileKey, videoFile.file, (frac) => {
              setStatus(status, `Uploading video (${Math.round(frac * 100)}%)…`);
            });
            payload.video_file_url = fileKey;
          } else if (isEdit) {
            payload.video_file_url = existing.video_file_url || '';
          }
        }

        if (isEdit) {
          await api.put(`/api/${type}/${existing.id}`, payload);
          setStatus(status, 'Saved.', true);
          if (opts.onSaved) opts.onSaved();
        } else {
          await api.post(`/api/${type}`, payload);
          setStatus(status, 'Published successfully.', true);
          // A modal-driven create (duplicate, or any future opts.onSaved
          // caller) closes/reloads via the caller; the plain Upload tab
          // (no onSaved) resets to a fresh form for the next entry.
          if (opts.onSaved) opts.onSaved();
          else buildForm(type, container);
        }
      } catch (err) {
        setStatus(status, err.message || 'Something went wrong.', false);
        submitBtn.disabled = false;
      }
    });
  }

  return { buildForm };
})();
