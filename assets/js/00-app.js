/* ===== Hypernote - frontend app logic =====
   Wires the UI to the HypernoteAPI Python bridge (window.pywebview.api).
   Consumes hyperkit primitives: HvToast (feedback), HvContextMenu (sidebar
   right-click). All file/notes/scratch operations round-trip through the bridge.
*/
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  function api() { return (window.pywebview && window.pywebview.api) || null; }

  // --- element refs ---
  var editor = $("editor");
  var titleInput = $("titleInput");
  var filetag = $("filetag");
  var dirtyDot = $("dirtyDot");
  var statusMode = $("statusMode");
  var wordCount = $("wordCount");
  var saveIndicator = $("saveIndicator");
  var sidebar = $("sidebar");
  var cheatsheet = $("cheatsheet");
  var noteList = $("noteList");
  var noteFilter = $("noteFilter");

  // --- state ---
  var dirty = false;
  var currentExt = "md";
  var currentPath = "";      // on-disk path if the buffer maps to a saved file
  var activeNotePath = null; // relpath within notes/ of the open exported note
  var filterText = "";
  var treeCache = { tree: [] };

  // ---------------------------------------------------------------------
  // Palette (accent sync from Hypervisor)
  // ---------------------------------------------------------------------
  window.applyAccent = function (p) {
    if (!p) return;
    var root = document.documentElement.style;
    if (p.accent) { root.setProperty("--accent", p.accent); root.setProperty("--success", p.accent); }
    if (p.warm) { root.setProperty("--warm", p.warm); root.setProperty("--warning", p.warm); }
    if (p.cool) { root.setProperty("--cool", p.cool); root.setProperty("--info", p.cool); }
    if (p.comp) { root.setProperty("--comp", p.comp); root.setProperty("--error", p.comp); }
    document.documentElement.classList.toggle("a11y-bw-theme", !!p.lightMode);
    syncCursors(p.accent || "#00ff41");
  };

  // Custom cursors are SVG data-URIs that can't reference CSS vars, so the
  // hyperkit CSS ships a hardcoded-green fallback and expects each app to
  // override --cursor-* at runtime with the accent-tinted data-URIs. Without
  // this the cursor stays green regardless of palette. (Mirrors Hyperagent.)
  function syncCursors(hex) {
    var ec = encodeURIComponent(hex);
    var root = document.documentElement.style;
    root.setProperty("--cursor-default", "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='" + ec + "' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z'/></svg>\") 2 2, auto");
    root.setProperty("--cursor-pointer", "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='" + ec + "' stroke='" + ec + "' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z'/></svg>\") 2 2, pointer");
    root.setProperty("--cursor-text", "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='" + ec + "' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1'/><path d='M7 22h1a4 4 0 0 0 4-4V6a4 4 0 0 0-4-4H7'/></svg>\") 10 10, text");
  }

  // ---------------------------------------------------------------------
  // Status / dirty / word count
  // ---------------------------------------------------------------------
  function markDirty(d) { dirty = d; dirtyDot.classList.toggle("dirty", d); }
  function updateWordCount() {
    var t = editor.value.trim();
    var n = t ? t.split(/\s+/).length : 0;
    wordCount.textContent = n + (n === 1 ? " word" : " words");
  }
  function flashSaved(label) {
    saveIndicator.textContent = label || "saved";
    saveIndicator.classList.add("visible");
    setTimeout(function () { saveIndicator.classList.remove("visible"); }, 1600);
  }
  function toast(msg, variant) {
    if (window.HvToast) window.HvToast.show({ variant: variant || "success", message: msg });
  }

  // Styled prompt against the hyperkit .prompt-dialog primitive (components.css),
  // replacing native window.prompt so the sidebar dialogs match the ecosystem.
  // Returns a Promise resolving to the entered string, or null if cancelled.
  function hnPrompt(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "confirm-dialog-overlay prompt-dialog-overlay";
      var box = document.createElement("div");
      box.className = "confirm-dialog-box prompt-dialog";
      var msg = document.createElement("div");
      msg.className = "confirm-dialog-message";
      msg.textContent = message;
      box.appendChild(msg);
      if (opts.hint) {
        var hint = document.createElement("div");
        hint.className = "prompt-dialog-hint";
        hint.textContent = opts.hint;
        box.appendChild(hint);
      }
      var input = document.createElement("input");
      input.type = "text";
      input.className = "prompt-dialog-input";
      input.value = opts.value || "";
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.autocomplete = "off";
      input.spellcheck = false;
      box.appendChild(input);
      var actions = document.createElement("div");
      actions.className = "confirm-dialog-actions";
      var cancelBtn = document.createElement("button");
      cancelBtn.className = "confirm-dialog-btn";
      cancelBtn.textContent = opts.cancelLabel || "cancel";
      var confirmBtn = document.createElement("button");
      confirmBtn.className = "confirm-dialog-btn";
      confirmBtn.textContent = opts.confirmLabel || "save";
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add("visible"); });
      function dismiss(result) {
        overlay.classList.remove("visible");
        setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 150);
        document.removeEventListener("keydown", onKey);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); dismiss(null); }
        if (e.key === "Enter") { e.preventDefault(); dismiss(input.value); }
      }
      cancelBtn.addEventListener("click", function () { dismiss(null); });
      confirmBtn.addEventListener("click", function () { dismiss(input.value); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) dismiss(null); });
      document.addEventListener("keydown", onKey);
      input.focus();
      input.select();
    });
  }
  function setFiletag(ext) {
    currentExt = ext === "txt" ? "txt" : "md";
    filetag.textContent = currentExt.toUpperCase();
    filetag.classList.remove("md", "txt");
    filetag.classList.add(currentExt);
  }
  function slugify(s) {
    return ((s || "untitled-note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || "untitled-note";
  }

  // ---------------------------------------------------------------------
  // Editor events
  // ---------------------------------------------------------------------
  editor.addEventListener("input", function () { markDirty(true); updateWordCount(); });
  titleInput.addEventListener("input", function () { markDirty(true); });
  editor.addEventListener("keydown", function (e) {
    if (e.key === "Tab") {
      e.preventDefault();
      var s = editor.selectionStart, en = editor.selectionEnd, v = editor.value;
      editor.value = v.substring(0, s) + "  " + v.substring(en);
      editor.selectionStart = editor.selectionEnd = s + 2;
      markDirty(true); updateWordCount();
    }
  });

  // ---------------------------------------------------------------------
  // File operations (bridge)
  // ---------------------------------------------------------------------
  function doNew() {
    editor.value = ""; titleInput.value = ""; currentPath = ""; activeNotePath = null;
    setFiletag("md"); statusMode.textContent = "new note"; markDirty(false); updateWordCount();
    highlightActive();
    toast("New note");
  }
  // Split a document into {title, body}: if it leads with an H1, that becomes
  // the title and is removed from the body; otherwise title falls back to the
  // filename and the whole content is the body.
  function splitDocument(content, fallbackTitle) {
    var text = content || "";
    var m = text.match(/^\s*#\s+(.+?)\s*(?:\n|$)/);
    if (m) {
      var body = text.slice(m.index + m[0].length).replace(/^\n+/, "");
      return { title: m[1].trim(), body: body };
    }
    return { title: fallbackTitle || "", body: text };
  }
  function doOpen() {
    var a = api(); if (!a) return;
    a.open_file().then(function (r) {
      if (!r || r.cancelled) return;
      if (r.error) { toast("Open failed: " + r.error, "error"); return; }
      var name = r.name ? r.name.replace(/\.(md|txt)$/i, "") : "";
      var split = splitDocument(r.content, name);
      editor.value = split.body;
      titleInput.value = split.title;
      currentPath = r.path || ""; activeNotePath = null;
      setFiletag(r.ext); statusMode.textContent = r.name || "opened"; markDirty(false); updateWordCount();
      highlightActive();
      toast("Opened " + (r.name || ""));
    });
  }
  // Compose the document text written to disk: the title becomes the leading
  // H1 so it persists in the file (the editor body holds everything below it).
  // If the body already opens with that exact H1, don't double it.
  function composeDocument() {
    var title = (titleInput.value || "").trim();
    var body = editor.value;
    if (!title) return body;
    var h1 = "# " + title;
    if (body.replace(/^\s+/, "").indexOf(h1) === 0) return body;
    return h1 + "\n\n" + body;
  }
  function doSave() {
    var a = api(); if (!a) return;
    var suggested = slugify(titleInput.value) + "." + currentExt;
    a.save_file(composeDocument(), suggested, currentPath).then(function (r) {
      if (!r || r.cancelled) return;
      if (r.error) { toast("Save failed: " + r.error, "error"); return; }
      currentPath = r.path; setFiletag(r.ext); statusMode.textContent = r.name;
      markDirty(false); flashSaved("saved"); toast("Saved " + r.name);
    });
  }
  function doSaveAs() {
    var a = api(); if (!a) return;
    var suggested = slugify(titleInput.value) + "." + currentExt;
    a.save_file(composeDocument(), suggested, "").then(function (r) {
      if (!r || r.cancelled) return;
      if (r.error) { toast("Save failed: " + r.error, "error"); return; }
      currentPath = r.path; setFiletag(r.ext); statusMode.textContent = r.name;
      markDirty(false); flashSaved("saved"); toast("Saved " + r.name);
    });
  }

  // ---------------------------------------------------------------------
  // File menu (click-anchored dropdown)
  // ---------------------------------------------------------------------
  var fileMenu = $("fileMenu");
  var fileMenuBtn = $("fileMenuBtn");
  function closeFileMenu() { fileMenu.classList.remove("open"); fileMenuBtn.classList.remove("toggle-active"); }
  fileMenuBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var open = fileMenu.classList.toggle("open");
    fileMenuBtn.classList.toggle("toggle-active", open);
  });
  fileMenu.addEventListener("click", function (e) {
    var item = e.target.closest(".menu-item"); if (!item) return;
    closeFileMenu();
    var act = item.getAttribute("data-act");
    if (act === "new") doNew();
    else if (act === "open") doOpen();
    else if (act === "save") doSave();
    else if (act === "saveas") doSaveAs();
    else if (act === "template") openTemplates();
    else if (act === "import") openImport();
    else if (act === "export") openExport();
  });
  document.addEventListener("click", closeFileMenu);

  // ---------------------------------------------------------------------
  // Insert engine — special elements Hypervisor's renderer supports.
  // Dispatched from the ribbon's data-ins buttons (see the formatBar handler).
  // ---------------------------------------------------------------------
  // Snippet templates. Callouts use GitHub-style admonition blockquotes
  // ([!TYPE]); collapsible uses the +++ Title / +++ fence; all match what
  // Hypervisor's markdown_processing renders. {SEL} is replaced by the current
  // selection (or a placeholder), and {CUR} marks where the cursor lands.
  var INSERT_SNIPPETS = {
    note:       "> [!NOTE]\n> {CUR}",
    tip:        "> [!TIP]\n> {CUR}",
    important:  "> [!IMPORTANT]\n> {CUR}",
    warning:    "> [!WARNING]\n> {CUR}",
    caution:    "> [!CAUTION]\n> {CUR}",
    collapsible:"+++ {CUR}\n\ncontent\n+++",
    table:      "| Column | Column |\n|--------|--------|\n| {CUR} | cell |\n| cell | cell |",
    tasklist:   "- [ ] {CUR}\n- [ ] task\n- [ ] task",
    codeblock:  "```\n{CUR}\n```",
  };

  // Insert a block on its own lines at the cursor: ensures a blank line before
  // and after so block constructs parse cleanly, and places the caret where
  // {CUR} sits (with any selected text substituted in).
  function insertBlock(template) {
    var s = editor.selectionStart, e = editor.selectionEnd, v = editor.value;
    var sel = v.substring(s, e);
    var curIdx = template.indexOf("{CUR}");
    var body = template.replace("{CUR}", sel);
    var before = v.substring(0, s);
    var after = v.substring(e);
    var lead = before && !/\n\n$/.test(before) ? (/\n$/.test(before) ? "\n" : "\n\n") : "";
    var trail = after && !/^\n\n/.test(after) ? (/^\n/.test(after) ? "\n" : "\n\n") : "";
    editor.value = before + lead + body + trail + after;
    // Caret at the end of the substituted {CUR} region.
    var caretAt = s + lead.length + curIdx + sel.length;
    editor.selectionStart = editor.selectionEnd = caretAt;
    editor.focus();
    markDirty(true); updateWordCount();
  }

  // ---------------------------------------------------------------------
  // Markdown formatting engine (acts on the textarea selection)
  // ---------------------------------------------------------------------
  function wrapFormat(before, after, placeholder) {
    var s = editor.selectionStart, e = editor.selectionEnd, v = editor.value;
    var sel = v.substring(s, e);
    if (sel && v.substring(s - before.length, s) === before && v.substring(e, e + after.length) === after) {
      editor.value = v.substring(0, s - before.length) + sel + v.substring(e + after.length);
      editor.selectionStart = s - before.length; editor.selectionEnd = e - before.length;
    } else {
      var body = sel || (placeholder || "");
      editor.value = v.substring(0, s) + before + body + after + v.substring(e);
      if (sel) { editor.selectionStart = s + before.length; editor.selectionEnd = e + before.length; }
      else { editor.selectionStart = editor.selectionEnd = s + before.length + body.length; }
    }
    editor.focus(); markDirty(true); updateWordCount();
  }
  function prefixFormat(prefix, numbered) {
    var s = editor.selectionStart, e = editor.selectionEnd, v = editor.value;
    var lineStart = v.lastIndexOf("\n", s - 1) + 1;
    var lineEnd = v.indexOf("\n", e); if (lineEnd === -1) lineEnd = v.length;
    var lines = v.substring(lineStart, lineEnd).split("\n");
    var allPrefixed = lines.every(function (ln) { return numbered ? /^\d+\.\s/.test(ln) : ln.indexOf(prefix) === 0; });
    var out = lines.map(function (ln, i) {
      if (allPrefixed) return numbered ? ln.replace(/^\d+\.\s/, "") : ln.substring(prefix.length);
      return (numbered ? (i + 1) + ". " : prefix) + ln;
    }).join("\n");
    editor.value = v.substring(0, lineStart) + out + v.substring(lineEnd);
    editor.selectionStart = lineStart; editor.selectionEnd = lineStart + out.length;
    editor.focus(); markDirty(true); updateWordCount();
  }
  function blockFormat() {
    var s = editor.selectionStart, e = editor.selectionEnd, v = editor.value;
    var sel = v.substring(s, e) || "code";
    var fenced = "```\n" + sel + "\n```";
    editor.value = v.substring(0, s) + fenced + v.substring(e);
    editor.selectionStart = s + 4; editor.selectionEnd = s + 4 + sel.length;
    editor.focus(); markDirty(true); updateWordCount();
  }
  function insertHr() {
    var s = editor.selectionStart, v = editor.value;
    var pre = (s > 0 && v[s - 1] !== "\n") ? "\n" : "";
    var text = pre + "\n---\n";
    editor.value = v.substring(0, s) + text + v.substring(s);
    editor.selectionStart = editor.selectionEnd = s + text.length;
    editor.focus(); markDirty(true); updateWordCount();
  }
  function applyFormat(fmt) {
    switch (fmt) {
      case "bold": return wrapFormat("**", "**", "bold text");
      case "italic": return wrapFormat("*", "*", "italic text");
      case "code": return wrapFormat("`", "`", "code");
      case "link": return wrapFormat("[", "](url)", "text");
      case "h1": return prefixFormat("# ");
      case "h2": return prefixFormat("## ");
      case "h3": return prefixFormat("### ");
      case "ul": return prefixFormat("- ");
      case "ol": return prefixFormat("", true);
      case "quote": return prefixFormat("> ");
      case "codeblock": return blockFormat();
      case "hr": return insertHr();
    }
  }
  $("formatBar").addEventListener("mousedown", function (e) {
    var btn = e.target.closest(".hn-fmt"); if (!btn) return;
    e.preventDefault(); // keep the textarea selection
    var ins = btn.getAttribute("data-ins");
    if (ins) { if (INSERT_SNIPPETS[ins]) insertBlock(INSERT_SNIPPETS[ins]); return; }
    applyFormat(btn.getAttribute("data-fmt"));
  });

  // --- Selection popup (C): floating inline toolbar over highlighted text ---
  var selBar = $("selBar");
  // Buttons act on the selection; mousedown+preventDefault keeps it intact.
  selBar.addEventListener("mousedown", function (e) {
    var btn = e.target.closest(".hn-fmt"); if (!btn) return;
    e.preventDefault();
    applyFormat(btn.getAttribute("data-fmt"));
    // Re-evaluate after the edit: wrapping keeps a selection, so keep the bar
    // where the (now-wrapped) text sits; a moment later reposition.
    setTimeout(updateSelBar, 0);
  });

  // Measure the pixel position of the textarea's selection end using a mirror
  // div — the only reliable way to place a popup over a textarea selection.
  function caretCoords(el, pos) {
    var div = document.createElement("div");
    var cs = getComputedStyle(el);
    [ "boxSizing","width","paddingTop","paddingRight","paddingBottom","paddingLeft",
      "borderWidth","fontFamily","fontSize","fontWeight","lineHeight","letterSpacing",
      "whiteSpace","wordWrap","tabSize" ].forEach(function (p) { div.style[p] = cs[p]; });
    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.wordWrap = "break-word";
    div.style.overflow = "hidden";
    div.textContent = el.value.substring(0, pos);
    var span = document.createElement("span");
    span.textContent = el.value.substring(pos) || ".";
    div.appendChild(span);
    document.body.appendChild(div);
    var rect = el.getBoundingClientRect();
    div.style.left = rect.left + "px";
    div.style.top = rect.top + "px";
    var top = rect.top + span.offsetTop - el.scrollTop;
    var left = rect.left + span.offsetLeft - el.scrollLeft;
    document.body.removeChild(div);
    return { top: top, left: left };
  }

  function updateSelBar() {
    var s = editor.selectionStart, e = editor.selectionEnd;
    if (s === e || document.activeElement !== editor) { hideSelBar(); return; }
    // Anchor to the START of the selection, popup floats just above it.
    var c = caretCoords(editor, s);
    selBar.classList.add("visible");
    var bw = selBar.offsetWidth, bh = selBar.offsetHeight;
    var top = c.top - bh - 6;
    var left = c.left - bw / 2;
    // Clamp to viewport.
    left = Math.max(4, Math.min(left, window.innerWidth - bw - 4));
    if (top < 4) top = c.top + 20; // flip below if no room above
    selBar.style.top = top + "px";
    selBar.style.left = left + "px";
    selBar.setAttribute("aria-hidden", "false");
  }
  function hideSelBar() {
    selBar.classList.remove("visible");
    selBar.setAttribute("aria-hidden", "true");
  }
  // Selection changes: mouseup/keyup in the editor, plus the global event.
  editor.addEventListener("mouseup", function () { setTimeout(updateSelBar, 0); });
  editor.addEventListener("keyup", function (e) {
    // Only recompute on selection-affecting keys (shift+arrows, ctrl+a, etc.)
    if (e.shiftKey || e.key === "ArrowLeft" || e.key === "ArrowRight" ||
        e.key === "ArrowUp" || e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "a")) {
      updateSelBar();
    } else {
      hideSelBar();
    }
  });
  editor.addEventListener("scroll", function () { if (selBar.classList.contains("visible")) updateSelBar(); });
  editor.addEventListener("blur", function () {
    // Delay so a click on the popup (which blurs the textarea) isn't lost.
    setTimeout(function () {
      if (!selBar.contains(document.activeElement)) hideSelBar();
    }, 120);
  });
  window.addEventListener("resize", hideSelBar);

  // ---------------------------------------------------------------------
  // Notes sidebar (tree from bridge, HvContextMenu for organize actions)
  // ---------------------------------------------------------------------
  function toggleSidebar() {
    var open = sidebar.classList.toggle("open");
    setViewCheck("viewNotesCheck", open);
    if (open) refreshTree();
  }
  function esc(s) { return window.HvUtils ? window.HvUtils.escapeHtml(s) : String(s); }

  function refreshTree() {
    var a = api(); if (!a) return;
    a.list_notes_tree().then(function (manifest) {
      treeCache = manifest || { tree: [] };
      renderTree();
    });
  }
  function nodeMatches(node) {
    if (!filterText) return true;
    if (node.type === "note") return (node.title || "").toLowerCase().indexOf(filterText) !== -1;
    return (node.children || []).some(nodeMatches);
  }
  function renderTree() {
    noteList.innerHTML = "";
    var tree = treeCache.tree || [];
    if (!tree.length) { noteList.innerHTML = '<div class="hn-empty">No notes yet &mdash; export one to populate notes/</div>'; return; }
    if (!tree.some(nodeMatches)) { noteList.innerHTML = '<div class="hn-empty">No matches</div>'; return; }
    renderLevel(noteList, tree);
  }
  function renderLevel(container, arr) {
    arr.forEach(function (node) {
      if (!nodeMatches(node)) return;
      if (node.type === "folder") {
        var forceOpen = !!filterText;
        var row = document.createElement("div");
        row.className = "hn-folder" + (node.collapsed && !forceOpen ? " collapsed" : "");
        row.innerHTML =
          '<span class="hn-folder-caret">&#9662;</span>' +
          '<span class="hn-folder-glyph">&#9683;</span>' +
          '<span class="hn-folder-name">' + esc(node.name) + '</span>' +
          '<span class="hn-folder-count">' + (node.children || []).length + '</span>';
        row.dataset.folder = node.name;
        row.addEventListener("click", function () {
          if (filterText) return;
          node.collapsed = !node.collapsed; renderTree();
        });
        container.appendChild(row);
        var wrap = document.createElement("div");
        wrap.className = "hn-folder-children";
        renderLevel(wrap, node.children || []);
        container.appendChild(wrap);
      } else {
        container.appendChild(buildNoteEl(node));
      }
    });
  }
  function buildNoteEl(n) {
    var el = document.createElement("div");
    el.className = "hn-note stagger-in";
    el.dataset.path = n.path;
    if (n.path === activeNotePath) el.classList.add("active");
    el.innerHTML =
      '<span class="hn-note-title">' + esc(n.title || n.path) + '</span>' +
      '<div class="hn-note-meta">' +
        '<span class="status-chip status-chip-outlined-muted">' + esc(n.tag || "notes") + '</span>' +
        '<span class="hn-note-age">' + esc(n.age || "") + '</span>' +
      '</div>' +
      '<button class="hn-note-del" data-tooltip="Delete">&times;</button>';
    el.querySelector(".hn-note-title").addEventListener("click", function () { openNote(n); });
    el.querySelector(".hn-note-del").addEventListener("click", function (e) { e.stopPropagation(); deleteNote(n); });
    setTimeout(function () { el.classList.remove("stagger-in"); el.classList.add("stagger-visible"); }, 20);
    return el;
  }
  function highlightActive() {
    noteList.querySelectorAll(".hn-note").forEach(function (r) {
      r.classList.toggle("active", r.dataset.path === activeNotePath);
    });
  }
  function openNote(n) { readNote(n); }
  function readNote(n) {
    var a = api(); if (!a || !a.read_note) {
      titleInput.value = n.title || ""; activeNotePath = n.path; highlightActive();
      return;
    }
    a.read_note(n.path).then(function (r) {
      if (!r || r.error) { toast("Open failed", "error"); return; }
      // Exported notes carry a metadata header: "# Title\n\ndesc\n\n- Created:...\n---\n\nbody".
      // Extract the H1 as the title, and load only the body below the "---".
      var text = r.content || "";
      var title = n.title || "";
      var hm = text.match(/^\s*#\s+(.+?)\s*(?:\n|$)/);
      if (hm) title = hm[1].trim();
      var body = text;
      var hr = text.indexOf("\n---\n");
      if (hr !== -1) {
        body = text.slice(hr + 5).replace(/^\n+/, "");
      } else if (hm) {
        body = text.slice(hm.index + hm[0].length).replace(/^\n+/, "");
      }
      editor.value = body; titleInput.value = title;
      setFiletag("md"); currentPath = r.path || ""; activeNotePath = n.path;
      statusMode.textContent = "notes/" + n.path; markDirty(false); updateWordCount();
      highlightActive(); toast("Opened " + (title || ""));
    });
  }
  function deleteNote(n) {
    var a = api(); if (!a) return;
    a.delete_note(n.path).then(function (r) {
      if (r && r.error) { toast("Delete failed", "error"); return; }
      if (activeNotePath === n.path) activeNotePath = null;
      toast("Deleted " + (n.title || "note"));
      refreshTree();
    });
  }

  // sidebar controls
  // View menu (dropdown of panel toggles, next to File)
  function setViewCheck(id, on) {
    var el = $(id); if (el) el.innerHTML = on ? "&#10003;" : "&nbsp;";
  }
  var viewMenu = $("viewMenu");
  var viewMenuBtn = $("viewMenuBtn");
  function closeViewMenu() { viewMenu.classList.remove("open"); viewMenuBtn.classList.remove("toggle-active"); }
  viewMenuBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    closeFileMenu();
    var open = viewMenu.classList.toggle("open");
    viewMenuBtn.classList.toggle("toggle-active", open);
  });
  viewMenu.addEventListener("click", function (e) {
    var item = e.target.closest(".menu-item"); if (!item) return;
    closeViewMenu();
    var v = item.getAttribute("data-view");
    if (v === "notes") toggleSidebar();
    else if (v === "cheat") toggleCheatsheet();
  });
  document.addEventListener("click", closeViewMenu);
  $("notesRefresh").addEventListener("click", refreshTree);
  $("newFolderBtn").addEventListener("click", function () {
    hnPrompt("New folder", { value: "New Folder", placeholder: "folder name", confirmLabel: "create" }).then(function (name) {
      if (name == null || !name.trim()) return;
      var a = api(); if (!a) return;
      a.create_folder(name.trim()).then(function (r) {
        if (r && r.error) { toast("Folder failed", "error"); return; }
        toast("Created folder"); refreshTree();
      });
    });
  });
  noteFilter.addEventListener("input", function () { filterText = noteFilter.value.trim().toLowerCase(); renderTree(); });

  // Context menu via hyperkit HvContextMenu
  function collectFolderNames() {
    var names = [];
    (function walk(arr) { (arr || []).forEach(function (x) { if (x.type === "folder") { names.push(x.name); walk(x.children); } }); })(treeCache.tree);
    return names;
  }
  if (window.HvContextMenu) {
    HvContextMenu.register(".hn-note", function (el) {
      var path = el.dataset.path;
      return [
        { label: "Open", action: function () { readNote({ path: path, title: el.querySelector(".hn-note-title").textContent }); } },
        { label: "Rename", action: function () {
            var cur = el.querySelector(".hn-note-title").textContent;
            hnPrompt("Rename note", { value: cur, confirmLabel: "rename" }).then(function (name) {
              if (name == null || !name.trim()) return;
              api().rename_note(path, name.trim()).then(function () { refreshTree(); });
            });
        } },
        { label: "Move to", children: (function () {
            var kids = [{ label: "(root)", action: function () { api().move_note(path, "").then(function () { refreshTree(); }); } }];
            collectFolderNames().forEach(function (f) {
              kids.push({ label: f, action: function () { api().move_note(path, f).then(function () { refreshTree(); }); } });
            });
            return kids;
        })() },
        { separator: true },
        { label: "Move up", action: function () { api().reorder_note(path, -1).then(refreshTree); } },
        { label: "Move down", action: function () { api().reorder_note(path, 1).then(refreshTree); } },
        { separator: true },
        { label: "Delete", action: function () { deleteNote({ path: path, title: el.querySelector(".hn-note-title").textContent }); } },
      ];
    });
    HvContextMenu.register(".hn-folder", function (el) {
      var name = el.dataset.folder;
      return [
        { label: "Rename folder", action: function () {
            hnPrompt("Rename folder", { value: name, confirmLabel: "rename" }).then(function (nn) {
              if (nn == null || !nn.trim()) return;
              api().rename_folder(name, nn.trim()).then(function (r) {
                if (r && r.error) { toast("Rename failed: " + r.error, "error"); return; }
                toast("Renamed folder"); refreshTree();
              });
            });
        } },
      ];
    });
  }

  // ---------------------------------------------------------------------
  // Import modal
  // ---------------------------------------------------------------------
  var importOverlay = $("importOverlay");
  var dayList = $("dayList");
  var selectedDay = null;
  function openImport() {
    var a = api(); if (!a) return;
    dayList.innerHTML = ""; selectedDay = null;
    a.list_scratch_days().then(function (days) {
      if (!days || !days.length) { dayList.innerHTML = '<div class="hn-empty">No scratch days found</div>'; }
      (days || []).forEach(function (d) {
        var row = document.createElement("div");
        row.className = "option-row";
        row.innerHTML = '<span class="option-row-mark"></span><span class="option-row-body"><span class="option-row-title">' + esc(d.date) + '</span></span><span class="option-row-meta">' + d.count + ' entries</span>';
        row.addEventListener("click", function () {
          dayList.querySelectorAll(".option-row").forEach(function (r) { r.classList.remove("selected"); });
          row.classList.add("selected"); selectedDay = d.date;
        });
        dayList.appendChild(row);
      });
      importOverlay.classList.add("visible");
    });
  }
  function confirmImport() {
    if (!selectedDay) { toast("Pick a day first", "warning"); return; }
    var a = api(); if (!a) return;
    a.import_scratch_day(selectedDay).then(function (r) {
      if (!r || r.error) { toast("Import failed", "error"); return; }
      editor.value = r.content || ""; titleInput.value = r.title || "";
      setFiletag("md"); currentPath = ""; activeNotePath = null;
      statusMode.textContent = "seeded from scratch " + selectedDay; markDirty(true); updateWordCount();
      highlightActive();
      importOverlay.classList.remove("visible");
      toast("Seeded from " + selectedDay);
    });
  }
  $("importCancel").addEventListener("click", function () { importOverlay.classList.remove("visible"); });
  $("importConfirm").addEventListener("click", confirmImport);

  // ---------------------------------------------------------------------
  // Template modal
  // ---------------------------------------------------------------------
  var templateOverlay = $("templateOverlay");
  var templateList = $("templateList");
  var selectedTemplate = null;
  function openTemplates() {
    var a = api(); if (!a) return;
    templateList.innerHTML = ""; selectedTemplate = null;
    a.list_templates().then(function (items) {
      if (!items || !items.length) { templateList.innerHTML = '<div class="hn-empty">No templates found</div>'; }
      (items || []).forEach(function (t) {
        var row = document.createElement("div");
        row.className = "option-row";
        row.innerHTML = '<span class="option-row-mark"></span><span class="option-row-body"><span class="option-row-title">' + esc(t.title) + '</span>' +
          (t.description ? '<span class="option-row-desc">' + esc(t.description) + '</span>' : '') + '</span>';
        row.addEventListener("click", function () {
          templateList.querySelectorAll(".option-row").forEach(function (r) { r.classList.remove("selected"); });
          row.classList.add("selected"); selectedTemplate = t.name;
        });
        row.addEventListener("dblclick", function () { selectedTemplate = t.name; confirmTemplate(); });
        templateList.appendChild(row);
      });
      templateOverlay.classList.add("visible");
    });
  }
  function loadTemplate(name, done) {
    var a = api(); if (!a) return;
    a.import_template(name).then(function (r) {
      if (!r || r.error) { toast("Template failed: " + (r && r.error), "error"); return; }
      var split = splitDocument(r.content, "");
      editor.value = split.body; titleInput.value = split.title;
      setFiletag("md"); currentPath = ""; activeNotePath = null;
      statusMode.textContent = "from template " + r.name; markDirty(true); updateWordCount();
      highlightActive();
      if (done) done();
    });
  }
  function confirmTemplate() {
    if (!selectedTemplate) { toast("Pick a template first", "warning"); return; }
    loadTemplate(selectedTemplate, function () {
      templateOverlay.classList.remove("visible");
      toast("Loaded " + selectedTemplate);
    });
  }
  $("templateCancel").addEventListener("click", function () { templateOverlay.classList.remove("visible"); });
  $("templateConfirm").addEventListener("click", confirmTemplate);

  // ---------------------------------------------------------------------
  // Export modal
  // ---------------------------------------------------------------------
  var exportOverlay = $("exportOverlay");
  var exportTitle = $("exportTitle");
  var slugPreview = $("slugPreview");
  var exportFolder = $("exportFolder");
  // Set when launched from a Hypervisor directory: export writes there instead of notes/.
  var launchDir = "";
  function openExport() {
    $("exportHeading").textContent = launchDir ? "Export to " + launchDir + "/" : "Export to notes/";
    $("exportDirHint").textContent = launchDir ? launchDir + "/" : "notes/";
    exportFolder.parentNode.style.display = launchDir ? "none" : "";
    exportTitle.value = titleInput.value || "";
    slugPreview.textContent = slugify(exportTitle.value) + ".md";
    // populate folder select from the tree
    exportFolder.innerHTML = '<option value="">(root)</option>';
    collectFolderNames().forEach(function (f) {
      var opt = document.createElement("option"); opt.value = f; opt.textContent = f; exportFolder.appendChild(opt);
    });
    exportOverlay.classList.add("visible");
    exportTitle.focus();
  }
  exportTitle.addEventListener("input", function () { slugPreview.textContent = slugify(exportTitle.value) + ".md"; });
  function confirmExport() {
    var a = api(); if (!a) return;
    if (launchDir) {
      a.export_to_directory(launchDir, exportTitle.value, composeDocument()).then(function (r) {
        if (!r || r.error) { toast("Export failed: " + (r && r.error), "error"); return; }
        exportOverlay.classList.remove("visible");
        titleInput.value = exportTitle.value; markDirty(false);
        statusMode.textContent = "exported → " + r.path;
        toast("Exported " + r.path + " — rebuilding");
      });
      return;
    }
    a.export_note(exportTitle.value, editor.value, exportFolder.value || "").then(function (r) {
      if (!r || r.error) { toast("Export failed: " + (r && r.error), "error"); return; }
      exportOverlay.classList.remove("visible");
      titleInput.value = exportTitle.value; activeNotePath = r.path; markDirty(false);
      statusMode.textContent = "exported \u2192 notes/" + r.path;
      toast("Exported notes/" + r.path + " \u2014 rebuilding");
      refreshTree();
    });
  }
  $("exportCancel").addEventListener("click", function () { exportOverlay.classList.remove("visible"); });
  $("exportConfirm").addEventListener("click", confirmExport);

  // Rebuild-complete signal from the bridge
  window.__hnRebuilt = function () { toast("Site rebuilt"); };

  // ---------------------------------------------------------------------
  // Cheatsheet (grammar mirrors the shared markdown renderer)
  // ---------------------------------------------------------------------
  var CHEAT_GROUPS = [
    { label: "Headings", rows: [["# H1", "heading 1"], ["## H2", "heading 2"], ["### H3", "heading 3"]] },
    { label: "Emphasis", rows: [["**bold**", "bold"], ["*italic*", "italic"], ["`code`", "inline code"]] },
    { label: "Lists", rows: [["- item", "bullet"], ["1. item", "numbered"], ["  - item", "nested (2 spaces)"]] },
    { label: "Blocks", rows: [["```lang", "fenced code"], ["> quote", "blockquote"], ["---", "horizontal rule"]] },
    { label: "Links & tables", rows: [["[text](url)", "link"], ["| a | b |", "table row"], ["|---|---|", "divider"]] },
    { label: "Callouts (ribbon)", rows: [["> [!NOTE]", "note"], ["> [!TIP]", "tip"], ["> [!WARNING]", "warning"], ["> [!CAUTION]", "caution"], ["> [!IMPORTANT]", "important"]] },
    { label: "Rich blocks", rows: [["+++ Title", "collapsible open"], ["+++", "collapsible close"], ["- [ ] task", "task list"]] },
  ];
  function buildCheatsheet() {
    $("cheatBody").innerHTML = CHEAT_GROUPS.map(function (g) {
      var rows = g.rows.map(function (r) {
        return '<div class="hn-cheat-row"><span class="hn-cheat-syntax">' +
          r[0].replace(/</g, "&lt;").replace(/>/g, "&gt;") +
          '</span><span class="hn-cheat-label">' + r[1] + '</span></div>';
      }).join("");
      return '<div class="hn-cheat-group"><div class="hn-cheat-group-label">' + g.label + '</div>' + rows + '</div>';
    }).join("");
  }
  function toggleCheatsheet() {
    var open = cheatsheet.classList.toggle("open");
    setViewCheck("viewCheatCheck", open);
  }
  $("cheatClose").addEventListener("click", toggleCheatsheet);

  // ---------------------------------------------------------------------
  // Global shortcuts
  // ---------------------------------------------------------------------
  document.addEventListener("keydown", function (e) {
    var ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); if (e.shiftKey) doSaveAs(); else doSave(); }
    else if (ctrl && e.key.toLowerCase() === "e") { e.preventDefault(); openExport(); }
    else if (ctrl && e.key.toLowerCase() === "o") { e.preventDefault(); doOpen(); }
    else if (ctrl && e.key.toLowerCase() === "n") { e.preventDefault(); doNew(); }
    else if (ctrl && e.key.toLowerCase() === "b") { e.preventDefault(); applyFormat("bold"); }
    else if (ctrl && e.key.toLowerCase() === "i") { e.preventDefault(); applyFormat("italic"); }
    else if (ctrl && e.key.toLowerCase() === "k") { e.preventDefault(); applyFormat("link"); }
    else if (ctrl && e.key === "\\") { e.preventDefault(); toggleSidebar(); }
    else if (e.key === "F1") { e.preventDefault(); toggleCheatsheet(); }
    else if (e.key === "Escape") { importOverlay.classList.remove("visible"); templateOverlay.classList.remove("visible"); exportOverlay.classList.remove("visible"); closeFileMenu(); }
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    buildCheatsheet();
    updateWordCount();
    setFiletag("md");
    // default-open sidebar
    sidebar.classList.add("open");
    setViewCheck("viewNotesCheck", true);
    setViewCheck("viewCheatCheck", false);
    // Pull accent + tree once the bridge is ready.
    var tries = 0;
    (function waitBridge() {
      if (api()) {
        api().get_accent().then(window.applyAccent);
        refreshTree();
        api().get_launch_context().then(function (ctx) {
          launchDir = (ctx && ctx.dir) || "";
          if (ctx && ctx.template) loadTemplate(ctx.template);
        });
      } else if (tries++ < 50) {
        setTimeout(waitBridge, 100);
      }
    })();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
