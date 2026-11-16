(function () {
  "use strict";

  var root = document.documentElement;
  var themeButton = document.getElementById("theme-toggle");
  var modal = document.getElementById("preview");
  var body = document.getElementById("preview-body");
  var title = document.getElementById("preview-title");
  var meta = document.getElementById("preview-meta");
  var rawLink = document.getElementById("preview-raw");
  var downloadLink = document.getElementById("preview-download");
  var closeButton = document.getElementById("preview-close");
  var filter = document.getElementById("filter");
  var empty = document.getElementById("empty");
  var lastFocus = null;
  var requestToken = 0;
  var controller = null;
  var objectURL = null;

  function releaseObjectURL() {
    if (objectURL) {
      URL.revokeObjectURL(objectURL);
      objectURL = null;
    }
  }

  function effectiveTheme() {
    if (root.dataset.theme === "light" || root.dataset.theme === "dark") return root.dataset.theme;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  if (themeButton) {
    themeButton.addEventListener("click", function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("filebrowser-theme", next); } catch (e) {}
    });
  }

  if (filter) {
    filter.addEventListener("input", function () {
      var q = filter.value.trim().toLowerCase();
      var rows = document.querySelectorAll(".file-row[data-name]");
      var visible = 0;
      rows.forEach(function (row) {
        var match = !q || row.getAttribute("data-name").toLowerCase().indexOf(q) !== -1;
        row.hidden = !match;
        if (match) visible += 1;
      });
      if (empty) empty.hidden = visible !== 0 || rows.length === 0;
    });
  }

  function withQuery(href, key, value) {
    var url = new URL(href, window.location.href);
    url.searchParams.set(key, value);
    return url.href;
  }

  function setActions(href, name) {
    rawLink.href = href;
    downloadLink.href = withQuery(href, "download", "1");
    if (name) downloadLink.setAttribute("download", name);
  }

  function state(text) {
    var div = document.createElement("div");
    div.className = "preview-state";
    div.textContent = text;
    body.replaceChildren(div);
  }

  function openPreview(link) {
    var href = link.getAttribute("href");
    if (!href) return;
    lastFocus = document.activeElement;
    title.textContent = link.getAttribute("data-name") || "Preview";
    meta.textContent = "Loading…";
    body.replaceChildren();
    state("Loading preview…");
    setActions(href, title.textContent);
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(function () { closeButton.focus(); });
    loadPreview(href);
  }

  function closePreview() {
    if (modal.hidden) return;
    requestToken += 1;
    if (controller) { controller.abort(); controller = null; }
    modal.hidden = true;
    document.body.style.overflow = "";
    body.replaceChildren();
    releaseObjectURL();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function loadPreview(href) {
    var token = ++requestToken;
    if (controller) controller.abort();
    controller = new AbortController();
    fetch(withQuery(href, "__fb", "preview"), {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      signal: controller.signal
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }).then(function (payload) {
      if (token !== requestToken) return;
      render(payload, href);
    }).catch(function (error) {
      if (token !== requestToken || error.name === "AbortError") return;
      meta.textContent = "Preview failed";
      var box = document.createElement("div");
      box.className = "binary-box";
      var p = document.createElement("p");
      p.textContent = "This file could not be previewed. Use Raw or Download.";
      var a = document.createElement("a");
      a.className = "button";
      a.href = href;
      a.textContent = "Open file";
      box.appendChild(p);
      box.appendChild(a);
      body.replaceChildren(box);
    });
  }

  function notice(text) {
    var p = document.createElement("p");
    p.className = "notice";
    p.textContent = text;
    return p;
  }

  function render(payload, href) {
    title.textContent = payload.name;
    meta.textContent = [payload.size_label, payload.modified].filter(Boolean).join(" · ");
    setActions(payload.raw_url, payload.name);
    rawLink.href = payload.raw_url;
    downloadLink.href = payload.download_url;

    if (payload.truncated) {
      meta.textContent += " · preview truncated";
    }

    releaseObjectURL();
    var content;
    switch (payload.kind) {
      case "image":
        if (/\.svg$/i.test(payload.name) && payload.content && !payload.truncated) {
          var blob = new Blob([payload.content], { type: "image/svg+xml" });
          objectURL = URL.createObjectURL(blob);
          content = document.createElement("img");
          content.src = objectURL;
        } else if (payload.truncated && payload.content) {
          content = document.createElement("pre");
          content.className = "preview-code";
          content.textContent = payload.content;
        } else {
          content = document.createElement("img");
          content.src = payload.raw_url;
        }
        content.alt = payload.name;
        content.loading = "eager";
        break;
      case "pdf":
        content = document.createElement("iframe");
        content.src = payload.raw_url;
        content.title = payload.name;
        break;
      case "video":
        content = document.createElement("video");
        content.src = payload.raw_url;
        content.controls = true;
        content.preload = "metadata";
        break;
      case "audio":
        content = document.createElement("audio");
        content.src = payload.raw_url;
        content.controls = true;
        content.preload = "metadata";
        break;
      case "markdown":
        content = markdownView(payload);
        break;
      case "text":
        content = document.createElement("pre");
        content.className = "preview-code";
        content.textContent = payload.content || "";
        break;
      default:
        content = document.createElement("div");
        content.className = "binary-box";
        var message = document.createElement("p");
        message.textContent = payload.message || "This file is binary.";
        var link = document.createElement("a");
        link.className = "button";
        link.href = payload.download_url;
        link.setAttribute("download", payload.name);
        link.textContent = "Download file";
        content.appendChild(message);
        content.appendChild(link);
    }

    body.replaceChildren();
    body.appendChild(content);
    if (payload.message && payload.kind !== "binary") {
      body.appendChild(notice(payload.message));
    }
    body.scrollTop = 0;
  }

  function markdownView(payload) {
    var wrap = document.createElement("div");
    var tabs = document.createElement("div");
    tabs.className = "preview-tabs";
    var renderedButton = document.createElement("button");
    renderedButton.type = "button";
    renderedButton.textContent = "Rendered";
    renderedButton.setAttribute("aria-pressed", "true");
    var sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.textContent = "Source";
    sourceButton.setAttribute("aria-pressed", "false");
    tabs.appendChild(renderedButton);
    tabs.appendChild(sourceButton);

    var rendered = document.createElement("article");
    rendered.className = "markdown preview-markdown";
    rendered.innerHTML = payload.html || "";
    var source = document.createElement("pre");
    source.className = "preview-code";
    source.textContent = payload.content || "";
    source.hidden = true;

    renderedButton.addEventListener("click", function () {
      rendered.hidden = false;
      source.hidden = true;
      renderedButton.setAttribute("aria-pressed", "true");
      sourceButton.setAttribute("aria-pressed", "false");
    });
    sourceButton.addEventListener("click", function () {
      rendered.hidden = true;
      source.hidden = false;
      renderedButton.setAttribute("aria-pressed", "false");
      sourceButton.setAttribute("aria-pressed", "true");
    });

    wrap.appendChild(tabs);
    wrap.appendChild(rendered);
    wrap.appendChild(source);
    return wrap;
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest("a[data-preview]");
    if (!link) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openPreview(link);
  });

  if (closeButton) closeButton.addEventListener("click", closePreview);
  if (modal) {
    modal.addEventListener("click", function (event) {
      if (event.target.hasAttribute("data-close")) closePreview();
    });
    modal.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
        return;
      }
      if (event.key !== "Tab") return;
      var focusable = modal.querySelectorAll("a[href], button:not([hidden]), iframe, video[controls], audio[controls]");
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key !== "/" || modal.hidden === false) return;
    var tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || event.target.isContentEditable) return;
    event.preventDefault();
    if (filter) filter.focus();
  });

  function openFromHash() {
    if (!window.location.hash || window.location.hash.indexOf("#preview=") !== 0) return;
    var name;
    try { name = decodeURIComponent(window.location.hash.slice(9)); } catch (e) { return; }
    var links = document.querySelectorAll("a[data-preview]");
    for (var i = 0; i < links.length; i += 1) {
      if (links[i].getAttribute("data-name") === name) {
        openPreview(links[i]);
        return;
      }
    }
  }
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
})();
