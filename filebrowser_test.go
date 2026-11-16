package filebrowser

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
)

type nextHandler struct{ called bool }

func (n *nextHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) error {
	n.called = true
	http.NotFound(w, r)
	return nil
}

func newTestBrowser(t *testing.T, root string) *FileBrowser {
	t.Helper()
	fb := &FileBrowser{
		Root:           root,
		Hide:           append([]string(nil), defaultHide...),
		Readme:         append([]string(nil), defaultReadmes...),
		PreviewMaxSize: 4096,
		BrowseLimit:    100,
	}
	fb.md = goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	)
	return fb
}

func serve(fb *FileBrowser, method, target string) (*httptest.ResponseRecorder, error) {
	req := httptest.NewRequest(method, "http://files.test"+target, nil)
	rec := httptest.NewRecorder()
	err := fb.ServeHTTP(rec, req, &nextHandler{})
	return rec, err
}

func TestDirectoryPageAndReadme(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("# Hello\n\n<script>alert(1)</script>\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "build.sh"), []byte("#!/bin/sh\necho hi\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	fb := newTestBrowser(t, root)
	rec, err := serve(fb, http.MethodGet, "/")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{"README.md", "build.sh", "sub/", "data-preview=\"1\"", "<h1", ">Hello</h1>"} {
		if !strings.Contains(body, want) {
			t.Errorf("page does not contain %q", want)
		}
	}
	if strings.Contains(body, "alert(1)") {
		t.Error("raw HTML from README was not sanitized")
	}
	if strings.Contains(body, `class="up"`) {
		t.Error("root page should not show a parent link")
	}
}

func TestDirectoryRedirect(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	fb := newTestBrowser(t, root)
	rec, err := serve(fb, http.MethodGet, "/sub")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want 308", rec.Code)
	}
	if got := rec.Header().Get("Location"); got != "/sub/" {
		t.Fatalf("Location = %q, want /sub/", got)
	}
}

func TestPreviewTextAndMarkdown(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "build.sh"), []byte("#!/bin/sh\necho hi\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("# Hello\n\n[site](https://example.com)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fb := newTestBrowser(t, root)

	rec, err := serve(fb, http.MethodGet, "/build.sh?__fb=preview")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var textPayload previewPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &textPayload); err != nil {
		t.Fatal(err)
	}
	if textPayload.Kind != "text" || !strings.Contains(textPayload.Content, "echo hi") {
		t.Fatalf("unexpected text payload: %+v", textPayload)
	}

	rec, err = serve(fb, http.MethodGet, "/README.md?__fb=preview")
	if err != nil {
		t.Fatal(err)
	}
	var mdPayload previewPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &mdPayload); err != nil {
		t.Fatal(err)
	}
	if mdPayload.Kind != "markdown" || !strings.Contains(mdPayload.HTML, "<h1") || !strings.Contains(mdPayload.HTML, ">Hello</h1>") {
		t.Fatalf("unexpected markdown payload: %+v", mdPayload)
	}
	if strings.Contains(mdPayload.HTML, "<script") {
		t.Error("markdown HTML was not sanitized")
	}
}

func TestPreviewSVG(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "logo.svg"), []byte(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`), 0o644); err != nil {
		t.Fatal(err)
	}
	fb := newTestBrowser(t, root)
	rec, err := serve(fb, http.MethodGet, "/logo.svg?__fb=preview")
	if err != nil {
		t.Fatal(err)
	}
	var payload previewPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Kind != "image" || !strings.Contains(payload.Content, "<svg") {
		t.Fatalf("unexpected SVG payload: %+v", payload)
	}
}

func TestPreviewBinaryAndTruncation(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "bin.dat"), []byte{0, 1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "long.txt"), []byte(strings.Repeat("x", 20)), 0o644); err != nil {
		t.Fatal(err)
	}
	fb := newTestBrowser(t, root)
	fb.PreviewMaxSize = 8

	rec, err := serve(fb, http.MethodGet, "/bin.dat?__fb=preview")
	if err != nil {
		t.Fatal(err)
	}
	var binPayload previewPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &binPayload); err != nil {
		t.Fatal(err)
	}
	if binPayload.Kind != "binary" {
		t.Fatalf("kind = %q, want binary", binPayload.Kind)
	}

	rec, err = serve(fb, http.MethodGet, "/long.txt?__fb=preview")
	if err != nil {
		t.Fatal(err)
	}
	var longPayload previewPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &longPayload); err != nil {
		t.Fatal(err)
	}
	if !longPayload.Truncated || len(longPayload.Content) != 8 {
		t.Fatalf("truncation failed: %+v", longPayload)
	}
}

func TestHiddenAndSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "escape.txt")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	fb := newTestBrowser(t, root)

	rec, err := serve(fb, http.MethodGet, "/")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rec.Body.String(), ".git") || strings.Contains(rec.Body.String(), "escape.txt") {
		t.Error("hidden or escaping entries leaked into the page")
	}

	_, err = serve(fb, http.MethodGet, "/.git/config")
	var handlerErr caddyhttp.HandlerError
	if !errors.As(err, &handlerErr) || handlerErr.StatusCode != http.StatusNotFound {
		t.Fatalf("hidden path error = %v, want HandlerError 404", err)
	}
	_, err = serve(fb, http.MethodGet, "/escape.txt")
	if !errors.As(err, &handlerErr) || handlerErr.StatusCode != http.StatusNotFound {
		t.Fatalf("symlink escape error = %v, want HandlerError 404", err)
	}
}

func TestFileServing(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	fb := newTestBrowser(t, root)
	rec, err := serve(fb, http.MethodGet, "/hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK || rec.Body.String() != "hello" {
		t.Fatalf("unexpected file response: %d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
}

func TestUnmarshalCaddyfile(t *testing.T) {
	d := caddyfile.NewTestDispenser(`filebrowser {
		root /srv/files
		hide .git *.log
		readme README.md README
		preview_max_size 2MiB
		browse_limit 50
	}`)
	var fb FileBrowser
	if err := fb.UnmarshalCaddyfile(d); err != nil {
		t.Fatal(err)
	}
	if fb.Root != "/srv/files" || len(fb.Hide) != 2 || len(fb.Readme) != 2 {
		t.Fatalf("unexpected parse result: %+v", fb)
	}
	if fb.PreviewMaxSize != 2<<20 || fb.BrowseLimit != 50 {
		t.Fatalf("unexpected sizes: %+v", fb)
	}
	if err := fb.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestModuleID(t *testing.T) {
	if got := (FileBrowser{}).CaddyModule().ID; got != "http.handlers.filebrowser" {
		t.Fatalf("module ID = %q", got)
	}
}
