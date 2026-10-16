// ================================================================
// MOISDES ADMIN — Shared rich-text editor
// richtext.js
// A small contenteditable-based WYSIWYG editor used everywhere a
// "description"-style field needs formatting (bold/italic/underline,
// font/size, alignment, RTL/LTR) instead of a plain <textarea>. Output
// is HTML, stored and rendered as-is on the public side.
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.richtext = (function () {
  const FONTS = ['Heebo', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma'];
  // execCommand's fontSize scale is 1-7 (not px) — browsers map these to
  // their own small/normal/large/etc steps, which is fine for a simple
  // description field and avoids hand-rolling font-size CSS injection.
  const SIZES = [['2', 'Small'], ['3', 'Normal'], ['5', 'Large'], ['7', 'Huge']];

  function toolbarButton(label, title, run) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rte-btn';
    b.innerHTML = label;
    b.title = title;
    // mousedown (not click) + preventDefault keeps the editor's current
    // text selection intact — a click alone lets the browser collapse
    // the selection into the button before the command can run on it.
    b.addEventListener('mousedown', (e) => { e.preventDefault(); run(); });
    return b;
  }

  // container: element to build the editor into.
  // initialHtml: starting content (already-stored HTML, or '').
  // Returns { getHtml(), setHtml(html), focus() }.
  function createEditor(container, initialHtml) {
    container.innerHTML = '';
    document.execCommand('defaultParagraphSeparator', false, 'p');

    const wrap = document.createElement('div');
    wrap.className = 'rte-wrap';

    const toolbar = document.createElement('div');
    toolbar.className = 'rte-toolbar';

    const editor = document.createElement('div');
    editor.className = 'rte-editor';
    editor.contentEditable = 'true';
    editor.dir = 'rtl';
    editor.innerHTML = initialHtml || '';

    toolbar.appendChild(toolbarButton('<b>B</b>', 'Bold', () => document.execCommand('bold')));
    toolbar.appendChild(toolbarButton('<i>I</i>', 'Italic', () => document.execCommand('italic')));
    toolbar.appendChild(toolbarButton('<u>U</u>', 'Underline', () => document.execCommand('underline')));

    const fontSel = document.createElement('select');
    fontSel.className = 'rte-select';
    fontSel.title = 'Font';
    fontSel.innerHTML = '<option value="">Font</option>' + FONTS.map((f) => `<option value="${f}">${f}</option>`).join('');
    fontSel.addEventListener('mousedown', (e) => e.stopPropagation());
    fontSel.addEventListener('change', () => {
      if (fontSel.value) document.execCommand('fontName', false, fontSel.value);
      editor.focus();
      fontSel.value = '';
    });
    toolbar.appendChild(fontSel);

    const sizeSel = document.createElement('select');
    sizeSel.className = 'rte-select';
    sizeSel.title = 'Size';
    sizeSel.innerHTML = '<option value="">Size</option>' + SIZES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sizeSel.addEventListener('mousedown', (e) => e.stopPropagation());
    sizeSel.addEventListener('change', () => {
      if (sizeSel.value) document.execCommand('fontSize', false, sizeSel.value);
      editor.focus();
      sizeSel.value = '';
    });
    toolbar.appendChild(sizeSel);

    toolbar.appendChild(toolbarButton('&#8677;', 'Align right', () => document.execCommand('justifyRight')));
    toolbar.appendChild(toolbarButton('&#8676;', 'Align left', () => document.execCommand('justifyLeft')));
    toolbar.appendChild(toolbarButton('&#8801;', 'Center', () => document.execCommand('justifyCenter')));
    toolbar.appendChild(toolbarButton('&#9776;', 'Justify', () => document.execCommand('justifyFull')));

    // Toggles the direction of whichever block (paragraph/div/list item/
    // heading) the cursor is currently in — not the whole editor — so a
    // stray English line inside otherwise-Hebrew text (or vice versa) can
    // be flipped on its own without affecting the rest.
    toolbar.appendChild(toolbarButton('RTL/LTR', 'Toggle text direction', () => {
      const sel = window.getSelection();
      let node = sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : editor;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      let block = node && node.closest ? node.closest('p,div,li,h1,h2,h3,blockquote') : null;
      if (!block || !editor.contains(block)) block = editor;
      block.dir = block.dir === 'ltr' ? 'rtl' : 'ltr';
    }));

    wrap.appendChild(toolbar);
    wrap.appendChild(editor);
    container.appendChild(wrap);

    return {
      getHtml: () => editor.innerHTML,
      setHtml: (html) => { editor.innerHTML = html || ''; },
      focus: () => editor.focus(),
    };
  }

  return { createEditor };
})();
