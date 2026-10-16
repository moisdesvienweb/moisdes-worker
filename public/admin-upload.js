// ================================================================
// MOISDES ADMIN — Upload panel (also powers the Browse & Edit modal)
// admin-upload.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminUpload = (function () {
  const api = window.MOISDES.api;
  const AF = window.MOISDES.adminFields;
  const CFG = window.MOISDES.CFG;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
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

  function parshaSelect(value) {
    const s = el('select');
    (CFG.parshiyot || []).forEach((p) => {
      const name = CFG.combined[p] || p;
      const o = el('option', '', name);
      o.value = name;
      if (name === value) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

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
    // itself) should submit.
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit') {
        e.preventDefault();
      }
    });

    const datePickerWrap = el('div');
    form.appendChild(fieldGroup(type === 'simchas' ? 'Date added' : 'Date', datePickerWrap));
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

      getExtra = () => ({ title: title.value, body: bodyField.editor.getHtml(), category: categoryInput.getValue(), tags: tagInput.getValue() });

    } else if (type === 'posters') {
      const parshaWrap = el('div');
      const select = parshaSelect(prefillSrc?.parsha);
      parshaWrap.appendChild(select);
      form.appendChild(fieldGroup('Parsha', parshaWrap));

      const galleryWrap = el('div');
      form.appendChild(fieldGroup('Images', galleryWrap));
      gallery = AF.createGalleryUploader(galleryWrap, { accept: 'image/*', existingFolder: existing?.folder_url });

      getExtra = () => ({ parsha: select.value });

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

    } else if (type === 'pdfs') {
      const title = textInput('Title', prefillSrc?.title);
      form.appendChild(fieldGroup('Title', title));

      const catWrap = el('div');
      form.appendChild(fieldGroup('Category', catWrap));
      categoryInput = AF.createCategoryInput(catWrap, prefillSrc?.category);

      const language = textInput('e.g. Yiddish / Hebrew / English', prefillSrc?.language);
      form.appendChild(fieldGroup('Language', language));

      const parshaWrap = el('div');
      const select = parshaSelect(prefillSrc?.parsha);
      parshaWrap.appendChild(select);
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
      form.appendChild(fieldGroup(isEdit ? 'Replace PDF file (optional)' : 'PDF file', pdfFileWrap));

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
      form.appendChild(fieldGroup(isEdit ? 'Replace thumbnail (optional)' : 'Cover thumbnail (optional — auto-generated if left blank)', thumbWrap));

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

      getExtra = () => ({ title: title.value, category: categoryInput.getValue(), language: language.value, parsha: select.value, year: year.getValue() });

      form._getPdfFile = () => ({ file: pdfFile, name: pdfFileName });
      form._getThumb = () => manualThumbFile
        ? { file: manualThumbFile, name: manualThumbFileName }
        : (autoThumbBlob ? { file: autoThumbBlob, name: 'cover.png' } : null);

    } else if (type === 'simchas') {
      const text = textarea('Simcha (e.g. names + occasion)', prefillSrc?.text);
      form.appendChild(fieldGroup('Text', text));
      getExtra = () => ({ text: text.value });
    }

    const submitBtn = el('button', 'btn btn-primary', isEdit ? 'Save changes' : 'Publish');
    submitBtn.type = 'submit';
    form.appendChild(submitBtn);
    form.appendChild(status);
    container.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      setStatus(status, 'Saving…');

      try {
        const date = datePicker.getIso();
        if (!date) throw new Error('Please choose a date.');
        const payload = type === 'simchas' ? { date_added: date, ...getExtra() } : { date, ...getExtra() };

        if (type === 'pdfs') {
          const { file: pdfFile, name: pdfName } = form._getPdfFile();
          const thumb = form._getThumb();
          if (!isEdit && !pdfFile) throw new Error('Please choose a PDF file.');
          if (pdfFile) {
            const pdfKey = `pdfs/${Date.now()}-${AF.sanitizeFilename(pdfName || pdfFile.name)}`;
            await api.uploadFile(pdfKey, pdfFile);
            payload.pdf_url = pdfKey;
          } else if (isEdit) {
            payload.pdf_url = existing.pdf_url || '';
          }
          if (thumb) {
            const thumbKey = `pdfs/${Date.now()}-thumb-${AF.sanitizeFilename(thumb.name)}`;
            await api.uploadFile(thumbKey, thumb.file);
            payload.thumb_url = thumbKey;
          } else if (isEdit) {
            payload.thumb_url = existing.thumb_url || '';
          }
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
