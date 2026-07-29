(function () {
  const contentEl = document.getElementById("content");
  const hintEl = document.getElementById("hint");
  const dropOverlay = document.getElementById("dropOverlay");

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

  function render(path, markdown) {
    if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
    const html = window.marked ? window.marked.parse(markdown || "") : escapeHtml(markdown || "");
    const header = path
      ? `<div class="doc-path">${escapeHtml(path)}</div>`
      : "";
    contentEl.innerHTML = header + html;
    if (window.hljs) {
      contentEl.querySelectorAll("pre code").forEach((block) => {
        try {
          window.hljs.highlightElement(block);
        } catch (_) {}
      });
    }
    window.scrollTo(0, 0);
  }

  function showError(msg) {
    contentEl.innerHTML = `<div class="doc-path">Error</div><pre><code>${escapeHtml(msg)}</code></pre>`;
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
    const v = parseFloat(localStorage.getItem(ZOOM_KEY));
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
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
