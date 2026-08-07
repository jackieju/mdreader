(function () {
  const contentEl = document.getElementById("content");
  const hintEl = document.getElementById("hint");
  const dropOverlay = document.getElementById("dropOverlay");
  const annoMenu = document.getElementById("annoMenu");
  const annoMenuAdd = document.getElementById("annoMenuAdd");
  const annoMenuCopy = document.getElementById("annoMenuCopy");
  const annoOverlay = document.getElementById("annoOverlay");
  const annoTitle = document.getElementById("annoDialogTitle");
  const annoLoc = document.getElementById("annoDialogLoc");
  const annoQuote = document.getElementById("annoDialogQuote");
  const annoView = document.getElementById("annoDialogView");
  const annoInput = document.getElementById("annoDialogInput");
  const annoDelete = document.getElementById("annoDelete");
  const annoCancel = document.getElementById("annoCancel");
  const annoEdit = document.getElementById("annoEdit");
  const annoSave = document.getElementById("annoSave");

  let currentDoc = { path: "", src: "" };
  let annotations = [];

  function ready() {
    return window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.core;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function configureMarked() {
    if (!window.marked || !window.hljs) return;
    window.marked.setOptions({
      gfm: true,
      breaks: false,
      headerIds: false,
      mangle: false,
      highlight: function (code, lang) {
        try {
          if (lang && window.hljs.getLanguage(lang)) {
            return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          }
          return window.hljs.highlightAuto(code).value;
        } catch (_) {
          return escapeHtml(code);
        }
      },
    });
  }

  function renderMarkdownWithLines(markdown) {
    const norm = String(markdown || "").replace(/\r\n?/g, "\n");
    if (!window.marked || !window.marked.lexer) {
      return { html: "<pre><code>" + escapeHtml(norm) + "</code></pre>", src: norm };
    }
    const tokens = window.marked.lexer(norm);
    let line = 1;
    let offset = 0;
    let html = "";
    for (const tok of tokens) {
      const startLine = line;
      const startOffset = offset;
      const rawLen = tok.raw ? tok.raw.length : 0;
      const newlines = tok.raw ? (tok.raw.match(/\n/g) || []).length : 0;
      line += newlines;
      offset += rawLen;
      if (tok.type === "space") continue;
      const one = [tok];
      one.links = tokens.links || {};
      let blockHtml = window.marked.parser(one);
      blockHtml = blockHtml.replace(
        /^(\s*)(<[a-zA-Z][a-zA-Z0-9-]*)/,
        `$1$2 data-source-line="${startLine}" data-src-offset="${startOffset}" data-src-len="${rawLen}"`
      );
      html += blockHtml;
    }
    return { html, src: norm };
  }

  function render(path, markdown) {
    if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
    const result = renderMarkdownWithLines(markdown);
    currentDoc = { path: path || "", src: result.src };
    const header = path
      ? `<div class="doc-path">${escapeHtml(path)}</div>`
      : "";
    contentEl.innerHTML = header + result.html;
    if (window.hljs) {
      contentEl.querySelectorAll("pre code").forEach((block) => {
        try {
          window.hljs.highlightElement(block);
        } catch (_) {}
      });
    }
    restoreAnnotations();
    window.scrollTo(0, 0);
  }

  function showError(msg) {
    currentDoc = { path: "", src: "" };
    annotations = [];
    contentEl.innerHTML = `<div class="doc-path">Error</div><pre><code>${escapeHtml(msg)}</code></pre>`;
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function isMarkdownPath(p) {
    return /\.(md|markdown|mdown|mkd|txt)$/i.test(p);
  }

  async function loadPath(path) {
    if (!path) return;
    try {
      const content = await window.__TAURI__.core.invoke("read_md", { path });
      render(path, content);
    } catch (e) {
      showError(String(e));
    }
  }

  const ANNO_PREFIX = "mdreader.anno.";

  function annoKey(path) {
    return ANNO_PREFIX + (path || "");
  }

  function annoLoad(path) {
    try {
      const raw = localStorage.getItem(annoKey(path));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function annoPersist() {
    try {
      localStorage.setItem(annoKey(currentDoc.path), JSON.stringify(annotations));
    } catch (_) {}
  }

  function annoNextId() {
    return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function annoById(id) {
    return annotations.find((x) => x.id === id) || null;
  }

  // marked strips markdown syntax, so rendered text is a subsequence of the raw
  // source. Walk raw, consuming a raw char whenever it matches the next rendered
  // char; the raw index after matching `rendered.length` chars is the source
  // offset that aligns with that rendered position.
  function renderedPrefixToRawIndex(raw, rendered) {
    let ri = 0;
    let ti = 0;
    while (ti < rendered.length && ri < raw.length) {
      if (raw[ri] === rendered[ti]) {
        ri++;
        ti++;
      } else {
        ri++;
      }
    }
    return ri;
  }

  // Inverse of the above: given a target index into raw, return the number of
  // rendered chars that precede it (its rendered offset).
  function rawIndexToRenderedOffset(raw, rendered, rawTarget) {
    let ri = 0;
    let ti = 0;
    while (ri < rawTarget && ri < raw.length) {
      if (ti < rendered.length && raw[ri] === rendered[ti]) {
        ri++;
        ti++;
      } else {
        ri++;
      }
    }
    return ti;
  }

  function offsetToLineCh(src, off) {
    let line = 1;
    let lineStart = 0;
    const end = Math.min(off, src.length);
    for (let i = 0; i < end; i++) {
      if (src[i] === "\n") {
        line++;
        lineStart = i + 1;
      }
    }
    return { line, ch: off - lineStart };
  }

  function srcLineText(line) {
    const lines = currentDoc.src.split("\n");
    return lines[line - 1] || "";
  }

  function findSourceBlock(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== contentEl) {
      if (el.getAttribute && el.getAttribute("data-source-line") != null) return el;
      el = el.parentElement;
    }
    return null;
  }

  function domToSource(range) {
    const block = findSourceBlock(range.startContainer);
    if (!block) return null;
    const srcOffset = parseInt(block.getAttribute("data-src-offset"), 10) || 0;
    const srcLen = parseInt(block.getAttribute("data-src-len"), 10) || 0;
    const pre = document.createRange();
    pre.setStart(block, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const renderedBefore = pre.toString();
    const raw = currentDoc.src.slice(srcOffset, srcOffset + srcLen);
    const rawIdx = renderedPrefixToRawIndex(raw, renderedBefore);
    const absOffset = srcOffset + rawIdx;
    const pos = offsetToLineCh(currentDoc.src, absOffset);
    return { line: pos.line, ch: pos.ch, srcOffset: absOffset };
  }

  function locateInDom(absOffset) {
    const blocks = contentEl.querySelectorAll("[data-source-line]");
    let target = null;
    for (const b of blocks) {
      const o = parseInt(b.getAttribute("data-src-offset"), 10) || 0;
      const l = parseInt(b.getAttribute("data-src-len"), 10) || 0;
      if (absOffset >= o && absOffset <= o + l) {
        target = b;
        break;
      }
    }
    if (!target) return null;
    const o = parseInt(target.getAttribute("data-src-offset"), 10) || 0;
    const l = parseInt(target.getAttribute("data-src-len"), 10) || 0;
    const raw = currentDoc.src.slice(o, o + l);
    const rendered = target.textContent || "";
    const renderedOffset = rawIndexToRenderedOffset(raw, rendered, absOffset - o);
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
    let acc = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (acc + len >= renderedOffset) {
        return { node, offset: renderedOffset - acc };
      }
      acc += len;
    }
    return { node: target, offset: 0 };
  }

  function makeDot(id) {
    const dot = document.createElement("sup");
    dot.className = "anno-dot";
    dot.setAttribute("data-anno-id", id);
    dot.setAttribute("contenteditable", "false");
    return dot;
  }

  function insertDot(anno) {
    const dot = makeDot(anno.id);
    const loc = locateInDom(anno.srcOffset);
    if (loc && loc.node && loc.node.nodeType === Node.TEXT_NODE) {
      const n = loc.node;
      const at = Math.max(0, Math.min(loc.offset, n.nodeValue.length));
      const after = n.splitText(at);
      after.parentNode.insertBefore(dot, after);
    } else if (loc && loc.node && loc.node.appendChild) {
      loc.node.appendChild(dot);
    } else {
      contentEl.appendChild(dot);
    }
  }

  function restoreAnnotations() {
    annotations = annoLoad(currentDoc.path);
    for (const a of annotations) insertDot(a);
  }

  let pendingRange = null;
  let pendingPos = null;
  let pendingQuote = "";
  let dlgMode = "create";
  let currentAnnoId = null;

  function quoteForRange(range, pos) {
    if (range && !range.collapsed) {
      const t = range.toString().trim();
      if (t) return t.slice(0, 80);
    }
    return srcLineText(pos.line).trim().slice(0, 80);
  }

  function showDialog() {
    annoOverlay.classList.add("visible");
  }

  function hideDialog() {
    annoOverlay.classList.remove("visible");
    currentAnnoId = null;
  }

  function locLabel(pos) {
    return `第 ${pos.line} 行 第 ${pos.ch + 1} 字符`;
  }

  function openAnnoCreate(range) {
    const pos = domToSource(range);
    if (!pos) return;
    pendingPos = pos;
    pendingQuote = quoteForRange(range, pos);
    dlgMode = "create";
    currentAnnoId = null;
    annoTitle.textContent = "添加注释";
    annoLoc.textContent = locLabel(pos);
    annoQuote.textContent = pendingQuote;
    annoQuote.style.display = pendingQuote ? "" : "none";
    annoView.style.display = "none";
    annoInput.style.display = "";
    annoInput.value = "";
    annoDelete.style.display = "none";
    annoEdit.style.display = "none";
    annoSave.style.display = "";
    showDialog();
    setTimeout(() => annoInput.focus(), 0);
  }

  function openAnnoView(id) {
    const a = annoById(id);
    if (!a) return;
    dlgMode = "view";
    currentAnnoId = id;
    annoTitle.textContent = "注释";
    annoLoc.textContent = locLabel(a);
    annoQuote.textContent = a.quote || "";
    annoQuote.style.display = a.quote ? "" : "none";
    annoView.textContent = a.text;
    annoView.style.display = "";
    annoInput.style.display = "none";
    annoDelete.style.display = "";
    annoEdit.style.display = "";
    annoSave.style.display = "none";
    showDialog();
  }

  function startAnnoEdit() {
    if (!currentAnnoId) return;
    const a = annoById(currentAnnoId);
    if (!a) return;
    dlgMode = "edit";
    annoView.style.display = "none";
    annoInput.style.display = "";
    annoInput.value = a.text;
    annoEdit.style.display = "none";
    annoDelete.style.display = "";
    annoSave.style.display = "";
    setTimeout(() => annoInput.focus(), 0);
  }

  function saveAnno() {
    const text = (annoInput.value || "").trim();
    if (!text) return;
    if (dlgMode === "create" && pendingPos) {
      const a = {
        id: annoNextId(),
        line: pendingPos.line,
        ch: pendingPos.ch,
        srcOffset: pendingPos.srcOffset,
        quote: pendingQuote || "",
        text,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      annotations.push(a);
      annoPersist();
      insertDot(a);
    } else if (dlgMode === "edit" && currentAnnoId) {
      const a = annoById(currentAnnoId);
      if (a) {
        a.text = text;
        a.updatedAt = Date.now();
        annoPersist();
      }
    }
    hideDialog();
  }

  function deleteAnno() {
    if (!currentAnnoId) return;
    const i = annotations.findIndex((x) => x.id === currentAnnoId);
    if (i >= 0) {
      annotations.splice(i, 1);
      annoPersist();
    }
    const dot = contentEl.querySelector(`.anno-dot[data-anno-id="${currentAnnoId}"]`);
    if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
    hideDialog();
  }

  function caretRangeAt(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) {
        const r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      }
    }
    return null;
  }

  function showMenu(x, y) {
    annoMenu.classList.add("visible");
    const mw = annoMenu.offsetWidth;
    const mh = annoMenu.offsetHeight;
    let left = x - mw / 2;
    let top = y - mh - 12;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    if (top < 8) top = y + 18;
    annoMenu.style.left = left + "px";
    annoMenu.style.top = top + "px";
  }

  function hideMenu() {
    annoMenu.classList.remove("visible");
  }

  async function copyText(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) {}
  }

  function buildExportText() {
    const list = annotations.slice().sort((a, b) => a.srcOffset - b.srcOffset);
    return list.map((a) => `第${a.line}行第${a.ch + 1}字符: ${a.text}`).join("\n") + (list.length ? "\n" : "");
  }

  function exportFilename() {
    const base = (currentDoc.path || "").split(/[\\/]/).pop() || "untitled";
    const stem = base.replace(/\.[^.]+$/, "");
    return stem + "注释.txt";
  }

  async function doExport() {
    hideMenu();
    if (!currentDoc.path) {
      showToast("先打开一个 .md 文件再导出注释。");
      return;
    }
    if (annotations.length === 0) {
      showToast("当前文档没有注释可导出。");
      return;
    }
    const content = buildExportText();
    const filename = exportFilename();
    try {
      const outPath = await window.__TAURI__.core.invoke("export_annotations", {
        srcPath: currentDoc.path,
        filename,
        content,
      });
      showToast(`已导出 ${annotations.length} 条注释 → ${String(outPath)}`);
    } catch (e) {
      showToast("导出失败: " + String(e));
    }
  }

  function wireAnnotationUi() {
    let lpTimer = null;
    let lpStart = null;

    contentEl.addEventListener(
      "touchstart",
      (e) => {
        if (e.target.closest && e.target.closest(".anno-dot")) return;
        const t = e.touches[0];
        lpStart = { x: t.clientX, y: t.clientY };
        lpTimer = setTimeout(() => {
          const r = caretRangeAt(lpStart.x, lpStart.y);
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.rangeCount) {
            pendingRange = sel.getRangeAt(0).cloneRange();
          } else if (r) {
            pendingRange = r;
          } else {
            return;
          }
          showMenu(lpStart.x, lpStart.y);
        }, 500);
      },
      { passive: true }
    );

    contentEl.addEventListener(
      "touchmove",
      (e) => {
        if (!lpStart || !lpTimer) return;
        const t = e.touches[0];
        if (Math.abs(t.clientX - lpStart.x) > 10 || Math.abs(t.clientY - lpStart.y) > 10) {
          clearTimeout(lpTimer);
          lpTimer = null;
        }
      },
      { passive: true }
    );

    contentEl.addEventListener("touchend", () => {
      if (lpTimer) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    });

    contentEl.addEventListener("mouseup", (e) => {
      if (e.target.closest && e.target.closest(".anno-dot")) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        pendingRange = sel.getRangeAt(0).cloneRange();
        showMenu(e.clientX, e.clientY);
      }
    });

    contentEl.addEventListener("click", (e) => {
      const dot = e.target.closest && e.target.closest(".anno-dot");
      if (dot) {
        e.preventDefault();
        e.stopPropagation();
        openAnnoView(dot.getAttribute("data-anno-id"));
      }
    });

    document.addEventListener(
      "touchstart",
      (e) => {
        if (annoMenu.contains(e.target)) return;
        hideMenu();
      },
      true
    );
    document.addEventListener(
      "mousedown",
      (e) => {
        if (annoMenu.contains(e.target)) return;
        hideMenu();
      },
      true
    );
    window.addEventListener("scroll", hideMenu, true);

    annoMenuAdd.addEventListener("click", () => {
      hideMenu();
      if (pendingRange) openAnnoCreate(pendingRange);
    });
    annoMenuCopy.addEventListener("click", async () => {
      hideMenu();
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString() : pendingRange ? pendingRange.toString() : "";
      await copyText(text);
    });

    annoSave.addEventListener("click", saveAnno);
    annoEdit.addEventListener("click", startAnnoEdit);
    annoDelete.addEventListener("click", deleteAnno);
    annoCancel.addEventListener("click", hideDialog);
    annoOverlay.addEventListener("click", (e) => {
      if (e.target === annoOverlay) hideDialog();
    });
  }

  function wire() {
    configureMarked();
    if (!ready()) {
      setTimeout(wire, 50);
      return;
    }
    const { listen } = window.__TAURI__.event;

    listen("md-loaded", (event) => {
      const p = event && event.payload;
      if (!p) return;
      render(p.path || "", p.content || "");
    });

    listen("md-error", (event) => {
      showError(String(event && event.payload));
    });

    const showDrop = () => dropOverlay.classList.add("visible");
    const hideDrop = () => dropOverlay.classList.remove("visible");
    hideDrop();

    listen("tauri://drag-drop", (event) => {
      hideDrop();
      const payload = event && event.payload;
      const paths = (payload && payload.paths) || payload || [];
      const first = Array.isArray(paths) ? paths[0] : null;
      if (!first) return;
      if (!isMarkdownPath(first)) {
        showError(`Not a markdown file: ${first}`);
        return;
      }
      loadPath(first);
    });

    listen("tauri://drag-enter", showDrop);
    listen("tauri://drag-over", showDrop);
    listen("tauri://drag-leave", hideDrop);

    window.__TAURI__.core
      .invoke("drain_pending")
      .then((paths) => {
        if (Array.isArray(paths) && paths.length > 0) {
          loadPath(paths[0]);
        }
      })
      .catch(() => {});
  }

  const ZOOM_KEY = "mdreader.zoom";
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3.0;
  const ZOOM_STEP = 0.1;
  const ZOOM_BASE_PX = 14;

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  function readZoom() {
    // Guard: localStorage may throw SecurityError under App Sandbox on first launch
    let v = NaN;
    try { v = parseFloat(localStorage.getItem(ZOOM_KEY)); } catch (_) {}
    return Number.isFinite(v) ? clampZoom(v) : 1.0;
  }

  function applyZoom(z) {
    const clamped = clampZoom(z);
    document.documentElement.style.fontSize = (ZOOM_BASE_PX * clamped) + "px";
    try {
      localStorage.setItem(ZOOM_KEY, String(clamped));
    } catch (_) {}
    return clamped;
  }

  let zoom = applyZoom(readZoom());

  function setZoom(next) {
    zoom = applyZoom(next);
  }

  const WIDTH_KEY = "mdreader.width";
  const WIDTH_MIN = 400;
  const WIDTH_MAX = 2000;
  const WIDTH_STEP = 60;
  const WIDTH_BASE = 900;

  function clampWidth(w) {
    return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, w));
  }

  function readWidth() {
    // Guard: localStorage may throw SecurityError under App Sandbox on first launch
    let v = NaN;
    try { v = parseFloat(localStorage.getItem(WIDTH_KEY)); } catch (_) {}
    return Number.isFinite(v) ? clampWidth(v) : WIDTH_BASE;
  }

  function applyWidth(w) {
    const clamped = clampWidth(w);
    document.documentElement.style.setProperty("--content-max-width", clamped + "px");
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch (_) {}
    return clamped;
  }

  let width = applyWidth(readWidth());

  function setWidth(next) {
    width = applyWidth(next);
  }

  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey && e.shiftKey)) return;
    const k = e.key;
    if (k === "=" || k === "+" || e.code === "Equal") {
      e.preventDefault();
      setZoom(zoom + ZOOM_STEP);
    } else if (k === "-" || k === "_" || e.code === "Minus") {
      e.preventDefault();
      setZoom(zoom - ZOOM_STEP);
    } else if (k === "0" || e.code === "Digit0") {
      e.preventDefault();
      setZoom(1.0);
    } else if (k === "." || k === ">" || e.code === "Period") {
      e.preventDefault();
      setWidth(width + WIDTH_STEP);
    } else if (k === "," || k === "<" || e.code === "Comma") {
      e.preventDefault();
      setWidth(width - WIDTH_STEP);
    }
  });

  function isMobile() {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");
  }

  async function pickAndOpen() {
    // iOS: picked path is security-scoped; read_md cannot re-open it after the
    // picker scope closes. open_md_dialog picks+reads in-scope, emits md-loaded.
    if (isMobile()) {
      try {
        await window.__TAURI__.core.invoke("open_md_dialog");
      } catch (e) {
        showError(String(e));
      }
      return;
    }

    const dialog = window.__TAURI__ && window.__TAURI__.dialog;
    if (!dialog || !dialog.open) {
      showError("File picker unavailable.");
      return;
    }
    try {
      const selected = await dialog.open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] },
        ],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (path) loadPath(path);
    } catch (e) {
      showError(String(e));
    }
  }

  function bind(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  }

  bind("btnOpen", pickAndOpen);
  bind("btnZoomOut", () => setZoom(zoom - ZOOM_STEP));
  bind("btnZoomIn", () => setZoom(zoom + ZOOM_STEP));
  bind("btnZoomReset", () => setZoom(1.0));
  bind("btnWidthDown", () => setWidth(width - WIDTH_STEP));
  bind("btnWidthUp", () => setWidth(width + WIDTH_STEP));
  bind("btnExport", doExport);

  wireAnnotationUi();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
