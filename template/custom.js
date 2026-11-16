/* caddy-github-browse: README and preview dialog for the stock Caddy file_server. */
(function () {
  "use strict";

  var MAX_PREVIEW = 1024 * 1024;
  var CODE_EXT = {
    sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
    go: "go", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", yaml: "yaml", yml: "yaml",
    toml: "ini", ini: "ini", conf: "ini", py: "python", rb: "ruby", rs: "rust",
    java: "java", kt: "kotlin", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", html: "xml", htm: "xml", xml: "xml", svg: "xml",
    css: "css", scss: "scss", sass: "scss", less: "scss", sql: "sql",
    md: "markdown", markdown: "markdown", ps1: "powershell", lua: "lua",
    swift: "swift", dockerfile: "dockerfile"
  };
  var MARKDOWN_EXT = { md: true, markdown: true };
  var IMAGE_EXT = { png: true, jpg: true, jpeg: true, gif: true, webp: true, avif: true, bmp: true, ico: true, svg: true };
  var VIDEO_EXT = { mp4: true, webm: true, mkv: true, mov: true, m4v: true, ogv: true };
  var AUDIO_EXT = { mp3: true, wav: true, ogg: true, flac: true, m4a: true, opus: true };
  var TEXT_EXT = { txt: true, log: true, csv: true, tsv: true, rst: true, adoc: true, tex: true, env: true, gitignore: true };

  var modal = null;
  var body = null;
  var title = null;
  var meta = null;
  var rawLink = null;
  var downloadLink = null;
  var closeButton = null;
  var lastFocus = null;
  var loadToken = 0;

  function extOf(name) {
    var i = name.lastIndexOf(".");
    return i < 0 ? "" : name.slice(i + 1).toLowerCase();
  }

  function languageOf(name) {
    var lower = name.toLowerCase();
    var ext = extOf(name);
    if (lower === "dockerfile") return "dockerfile";
    if (lower === "makefile") return "makefile";
    if (lower === "caddyfile") return "nginx";
    return CODE_EXT[ext] || "";
  }

  function kindOf(name) {
    var ext = extOf(name);
    if (MARKDOWN_EXT[ext]) return "markdown";
    if (IMAGE_EXT[ext]) return "image";
    if (ext === "pdf") return "pdf";
    if (VIDEO_EXT[ext]) return "video";
    if (AUDIO_EXT[ext]) return "audio";
    if (CODE_EXT[ext] || TEXT_EXT[ext]) return "text";
    return "binary";
  }

  function highlight(scope) {
    if (!window.hljs || !scope) return;
    scope.querySelectorAll("pre code").forEach(function (block) {
      if (block.dataset.fbHighlighted) return;
      try {
        window.hljs.highlightElement(block);
        block.dataset.fbHighlighted = "1";
      } catch (e) {}
    });
  }

  function sanitize(html) {
    if (window.DOMPurify) {
      if (!window.fbPurifyHook) {
        window.fbPurifyHook = true;
        window.DOMPurify.addHook("afterSanitizeAttributes", function (node) {
          if (node.tagName === "A") {
            var href = node.getAttribute("href") || "";
            if (/^https?:/i.test(href)) {
              node.setAttribute("target", "_blank");
              node.setAttribute("rel", "noopener noreferrer");
            }
          }
        });
      }
      return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return html;
  }

  function renderMarkdown(text) {
    if (!window.marked) return "<pre>" + text.replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    }) + "</pre>";
    return sanitize(window.marked.parse(text, { gfm: true, breaks: false }));
  }

  function nameFromLink(link) {
    var nameEl = link.querySelector(".name");
    if (nameEl) return nameEl.textContent.trim().replace(/\/$/, "");
    var href = link.getAttribute("href") || "";
    try { return decodeURIComponent(new URL(href, window.location.href).pathname.split("/").filter(Boolean).pop() || href); }
    catch (e) { return href; }
  }

  function withDownload(href) {
    var url = new URL(href, window.location.href);
    url.searchParams.set("download", "1");
    return url.href;
  }

  function fetchText(url) {
    return fetch(url, {
      cache: "no-cache",
      headers: { Range: "bytes=0-" + (MAX_PREVIEW - 1) }
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      var type = response.headers.get("Content-Type") || "";
      var length = Number(response.headers.get("Content-Length") || 0);
      var contentRange = response.headers.get("Content-Range") || "";
      var total = 0;
      if (contentRange.indexOf("/") !== -1) total = Number(contentRange.split("/")[1]) || 0;
      var partial = (total > MAX_PREVIEW) || (response.status === 206 && length >= MAX_PREVIEW);
      return response.text().then(function (text) {
        if (text.indexOf("\u0000") !== -1) {
          return { text: "", type: type, partial: partial, binary: true };
        }
        return { text: text, type: type, partial: partial, binary: false };
      });
    });
  }

  function buildModal() {
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "fb-modal";
    modal.hidden = true;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "fb-preview-title");
    modal.innerHTML =
      '<div class="fb-modal-backdrop" data-fb-close></div>' +
      '<div class="fb-modal-card">' +
        '<header class="fb-modal-head">' +
          '<div><p class="fb-modal-kicker">Preview</p><h2 class="fb-modal-title" id="fb-preview-title"></h2><p class="fb-modal-meta"></p></div>' +
          '<div class="fb-modal-actions">' +
            '<a class="fb-button" data-fb-raw target="_blank" rel="noopener">Raw</a>' +
            '<a class="fb-button" data-fb-download download>Download</a>' +
            '<button class="fb-button" type="button" data-fb-close aria-label="Close preview">Close</button>' +
          '</div>' +
        '</header>' +
        '<div class="fb-modal-body"></div>' +
      '</div>';
    document.body.appendChild(modal);
    body = modal.querySelector(".fb-modal-body");
    title = modal.querySelector(".fb-modal-title");
    meta = modal.querySelector(".fb-modal-meta");
    rawLink = modal.querySelector("[data-fb-raw]");
    downloadLink = modal.querySelector("[data-fb-download]");
    closeButton = modal.querySelector("button[data-fb-close]");
    modal.addEventListener("click", function (event) {
      if (event.target.hasAttribute("data-fb-close")) close();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !modal.hidden) close();
    });
  }

  function state(text) {
    var div = document.createElement("div");
    div.className = "fb-state";
    div.textContent = text;
    body.replaceChildren(div);
  }

  function makeCode(text, language) {
    var pre = document.createElement("pre");
    pre.className = "fb-code";
    var code = document.createElement("code");
    code.textContent = text;
    if (language) code.className = "language-" + language;
    pre.appendChild(code);
    try { if (window.hljs) window.hljs.highlightElement(code); } catch (e) {}
    return pre;
  }

  function markdownView(text, language) {
    var wrap = document.createElement("div");
    var tabs = document.createElement("div");
    tabs.className = "fb-tabs";
    var renderedBtn = document.createElement("button");
    renderedBtn.type = "button";
    renderedBtn.textContent = "Rendered";
    renderedBtn.setAttribute("aria-pressed", "true");
    var sourceBtn = document.createElement("button");
    sourceBtn.type = "button";
    sourceBtn.textContent = "Source";
    sourceBtn.setAttribute("aria-pressed", "false");
    tabs.appendChild(renderedBtn);
    tabs.appendChild(sourceBtn);

    var rendered = document.createElement("article");
    rendered.className = "fb-markdown";
    rendered.innerHTML = renderMarkdown(text);
    highlight(rendered);
    var source = makeCode(text, language || "markdown");
    source.hidden = true;

    renderedBtn.addEventListener("click", function () {
      rendered.hidden = false; source.hidden = true;
      renderedBtn.setAttribute("aria-pressed", "true"); sourceBtn.setAttribute("aria-pressed", "false");
    });
    sourceBtn.addEventListener("click", function () {
      rendered.hidden = true; source.hidden = false;
      renderedBtn.setAttribute("aria-pressed", "false"); sourceBtn.setAttribute("aria-pressed", "true");
    });

    wrap.appendChild(tabs);
    wrap.appendChild(rendered);
    wrap.appendChild(source);
    return wrap;
  }

  function open(link) {
    buildModal();
    var href = link.getAttribute("href");
    if (!href) return;
    lastFocus = document.activeElement;
    var name = nameFromLink(link);
    var kind = kindOf(name);
    title.textContent = name;
    meta.textContent = "Loading…";
    rawLink.href = href;
    downloadLink.href = withDownload(href);
    downloadLink.setAttribute("download", name);
    body.replaceChildren();
    state("Loading preview…");
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    closeButton.focus();
    loadToken += 1;
    var token = loadToken;

    if (kind === "image") {
      var img = document.createElement("img");
      img.src = href;
      img.alt = name;
      body.replaceChildren(img);
      meta.textContent = "Image";
      return;
    }
    if (kind === "pdf") {
      var frame = document.createElement("iframe");
      frame.src = href;
      frame.title = name;
      body.replaceChildren(frame);
      meta.textContent = "PDF";
      return;
    }
    if (kind === "video" || kind === "audio") {
      var media = document.createElement(kind);
      media.src = href;
      media.controls = true;
      media.preload = "metadata";
      body.replaceChildren(media);
      meta.textContent = kind === "video" ? "Video" : "Audio";
      return;
    }
    if (kind === "binary") {
      var box = document.createElement("div");
      box.className = "fb-binary";
      box.textContent = "This file cannot be shown as text. Use Download or Raw.";
      body.replaceChildren(box);
      meta.textContent = "Binary file";
      return;
    }

    fetchText(href).then(function (result) {
      if (token !== loadToken) return;
      if (result.binary) {
        var box = document.createElement("div");
        box.className = "fb-binary";
        box.textContent = "This file cannot be shown as text. Use Download or Raw.";
        body.replaceChildren(box);
        meta.textContent = "Binary file";
        return;
      }
      var language = languageOf(name);
      body.replaceChildren();
      if (kind === "markdown") {
        body.appendChild(markdownView(result.text, language));
      } else {
        body.appendChild(makeCode(result.text, language));
      }
      meta.textContent = (language ? language + " · " : "") + (result.partial ? "preview limited to 1 MiB" : "text preview");
    }).catch(function (error) {
      if (token !== loadToken) return;
      state("Preview failed: " + error.message + ". Use Raw or Download.");
    });
  }

  function close() {
    if (!modal || modal.hidden) return;
    loadToken += 1;
    modal.hidden = true;
    document.body.style.overflow = "";
    body.replaceChildren();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function loadReadme() {
    var listing = document.querySelector(".listing");
    if (!listing) return;
    var names = ["README.md", "README.markdown", "README", "readme.md"];
    var index = 0;
    function next() {
      if (index >= names.length) return;
      var name = names[index++];
      fetch(name, { cache: "no-cache", headers: { Range: "bytes=0-" + (MAX_PREVIEW - 1) } })
        .then(function (response) {
          if (!response.ok) throw new Error("missing");
          return response.text();
        })
        .then(function (text) {
          if (!text.trim()) throw new Error("empty");
          var section = document.createElement("section");
          section.id = "fb-readme";
          var head = document.createElement("div");
          head.className = "fb-readme-head";
          var label = document.createElement("div");
          label.textContent = name;
          var raw = document.createElement("a");
          raw.href = name;
          raw.textContent = "Raw";
          head.appendChild(label);
          head.appendChild(raw);
          var article = document.createElement("article");
          article.className = "fb-readme-body";
          if (/\.(md|markdown)$/i.test(name) && window.marked) {
            article.className += " fb-markdown";
            article.innerHTML = renderMarkdown(text);
            highlight(article);
          } else {
            var pre = document.createElement("pre");
            pre.className = "fb-code";
            var code = document.createElement("code");
            code.textContent = text;
            pre.appendChild(code);
            try { if (window.hljs) window.hljs.highlightElement(code); } catch (e) {}
            article.appendChild(pre);
          }
          section.appendChild(head);
          section.appendChild(article);
          listing.after(section);
        })
        .catch(function () { next(); });
    }
    next();
  }

  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest("a[href]");
    if (!link) return;
    var row = link.closest("tr.file, .grid .entry");
    if (!row) return;
    var href = link.getAttribute("href");
    if (!href || href === ".." || href.charAt(0) === "?" || href.slice(-1) === "/") return;
    var url;
    try { url = new URL(href, window.location.href); } catch (e) { return; }
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    open(link);
  });

  function openFromHash() {
    if (!window.location.hash || window.location.hash.indexOf("#preview=") !== 0) return;
    var name;
    try { name = decodeURIComponent(window.location.hash.slice(9)); } catch (e) { return; }
    var links = document.querySelectorAll("tr.file a[href], .grid .entry a[href]");
    for (var i = 0; i < links.length; i += 1) {
      if (nameFromLink(links[i]) === name) {
        open(links[i]);
        return;
      }
    }
  }

  window.addEventListener("hashchange", openFromHash);
  window.addEventListener("load", function () {
    loadReadme();
    openFromHash();
  });
})();
