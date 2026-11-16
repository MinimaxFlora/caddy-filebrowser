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

  function detectLicense(tab) {
    var names = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md"];
    var index = 0;
    function next() {
      if (index >= names.length) return;
      var name = names[index++];
      fetch(name, { cache: "no-cache", headers: { Range: "bytes=0-4095" } })
        .then(function (response) {
          if (!response.ok) throw new Error("missing");
          return response.text();
        })
        .then(function (text) {
          var label = "License";
          if (/Apache License/i.test(text)) label = "Apache-2.0 license";
          else if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) label = "MIT license";
          else if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) label = "GPL license";
          else if (/BSD 3-Clause|Redistribution and use in source and binary forms/i.test(text)) label = "BSD license";
          tab.href = name;
          tab.querySelector(".fb-license-label").textContent = label;
          tab.hidden = false;
        })
        .catch(function () { next(); });
    }
    next();
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
          var tabs = document.createElement("div");
          tabs.className = "fb-readme-tabs";
          var readmeTab = document.createElement("span");
          readmeTab.className = "fb-readme-tab fb-readme-tab-active";
          readmeTab.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.75 3.75 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"/></svg><span>README</span>';
          tabs.appendChild(readmeTab);
          var licenseTab = document.createElement("a");
          licenseTab.className = "fb-readme-tab";
          licenseTab.hidden = true;
          licenseTab.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.75.75V2h.985c.304 0 .603.08.867.231l1.29.736c.038.022.08.033.124.033h2.234a.75.75 0 0 1 0 1.5h-.427l2.111 4.692a.75.75 0 0 1-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.006.005-.01.01-.045.04c-.21.176-.441.327-.686.45C14.556 10.78 13.88 11 13 11a4.498 4.498 0 0 1-2.023-.454 3.544 3.544 0 0 1-.686-.45l-.045-.04-.016-.015-.006-.006-.004-.004v-.001a.75.75 0 0 1-.154-.838L12.178 4.5h-.162c-.305 0-.604-.079-.868-.231l-1.29-.736a.245.245 0 0 0-.124-.033H8.75V13h2.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5h2.5V3.5h-.984a.245.245 0 0 0-.124.033l-1.289.737c-.265.15-.564.23-.869.23h-.162l2.112 4.692a.75.75 0 0 1-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.016.015-.045.04c-.21.176-.441.327-.686.45C4.556 10.78 3.88 11 3 11a4.498 4.498 0 0 1-2.023-.454 3.544 3.544 0 0 1-.686-.45l-.045-.04-.016-.015-.006-.006-.004-.004v-.001a.75.75 0 0 1-.154-.838L2.178 4.5H1.75a.75.75 0 0 1 0-1.5h2.234a.249.249 0 0 0 .125-.033l1.288-.737c.265-.15.564-.23.869-.23h.984V.75a.75.75 0 0 1 1.5 0Zm2.945 8.477c.285.135.718.273 1.305.273s1.02-.138 1.305-.273L13 6.327Zm-10 0c.285.135.718.273 1.305.273s1.02-.138 1.305-.273L3 6.327Z"/></svg><span class="fb-license-label">License</span>';
          tabs.appendChild(licenseTab);
          var actions = document.createElement("div");
          actions.className = "fb-readme-actions";
          var raw = document.createElement("a");
          raw.href = name;
          raw.className = "fb-readme-raw";
          raw.textContent = "Raw";
          actions.appendChild(raw);
          head.appendChild(tabs);
          head.appendChild(actions);

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
          detectLicense(licenseTab);
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
