// Package filebrowser implements a GitHub-like file browser for Caddy v2.
//
// It serves a directory listing with a rendered README and opens text, code,
// Markdown, image, PDF, audio and video files in an in-page preview dialog.
package filebrowser

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"html/template"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/dustin/go-humanize"
	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"go.uber.org/zap"
)

const (
	moduleVersion     = "0.1.0"
	previewQuery      = "__fb"
	previewValue      = "preview"
	defaultPreviewMax = int64(1 << 20)  // 1 MiB
	maxPreviewMax     = int64(64 << 20) // 64 MiB
	defaultBrowseMax  = 10000
	maxBrowseLimit    = 100000
)

var defaultHide = []string{".git", ".env", ".DS_Store", "Thumbs.db", "node_modules", "__pycache__"}
var defaultReadmes = []string{"README.md", "README.markdown", "README", "readme.md"}

var (
	//go:embed assets/index.html assets/style.css assets/app.js
	assetsFS embed.FS

	pageTemplate = template.Must(template.ParseFS(assetsFS, "assets/index.html"))
	cssText      = mustAsset("assets/style.css")
	jsText       = mustAsset("assets/app.js")
	sanitizer    = bluemonday.UGCPolicy()
)

func mustAsset(name string) string {
	b, err := assetsFS.ReadFile(name)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func init() {
	caddy.RegisterModule(FileBrowser{})
	httpcaddyfile.RegisterHandlerDirective("filebrowser", parseCaddyfile)
	httpcaddyfile.RegisterDirectiveOrder("filebrowser", httpcaddyfile.Before, "file_server")
}

// FileBrowser is an HTTP handler that renders a browsable directory with a
// README and an in-page file preview.
type FileBrowser struct {
	// Root is the directory to serve. It defaults to the site root set by the
	// Caddyfile `root` directive. Placeholders are expanded per request.
	Root string `json:"root,omitempty"`

	// Hide lists file or directory names/patterns that are neither listed nor
	// directly accessible. Patterns use path.Match syntax and are matched
	// against each path segment, or against the whole relative path when the
	// pattern contains a slash. Defaults: .git .env .DS_Store Thumbs.db
	// node_modules __pycache__.
	Hide []string `json:"hide,omitempty"`

	// Readme lists the file names checked, in order, for the README card.
	// Matching is case-insensitive and only applies to files directly inside
	// the browsed directory. Defaults: README.md README.markdown README readme.md.
	Readme []string `json:"readme,omitempty"`

	// PreviewMaxSize limits how much text is read for the preview dialog and
	// the README. Larger files are listed and can be downloaded, but previews
	// are truncated. Default: 1 MiB.
	PreviewMaxSize int64 `json:"preview_max_size,omitempty"`

	// BrowseLimit caps the number of entries rendered in one directory.
	// Default: 10000, maximum: 100000.
	BrowseLimit int `json:"browse_limit,omitempty"`

	Logger *zap.Logger `json:"-"`
	md     goldmark.Markdown
}

// CaddyModule returns the Caddy module information.
func (FileBrowser) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.filebrowser",
		New: func() caddy.Module { return new(FileBrowser) },
	}
}

// Provision initializes defaults and the Markdown renderer.
func (fb *FileBrowser) Provision(ctx caddy.Context) error {
	fb.Logger = ctx.Logger(fb)
	if fb.Root == "" {
		fb.Root = "{http.vars.root}"
	}
	if fb.Hide == nil {
		fb.Hide = append([]string(nil), defaultHide...)
	}
	if fb.Readme == nil {
		fb.Readme = append([]string(nil), defaultReadmes...)
	}
	if fb.PreviewMaxSize <= 0 {
		fb.PreviewMaxSize = defaultPreviewMax
	}
	if fb.BrowseLimit <= 0 {
		fb.BrowseLimit = defaultBrowseMax
	}
	fb.md = goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	)
	return nil
}

// Validate checks bounds and that README names are plain file names.
func (fb *FileBrowser) Validate() error {
	if fb.PreviewMaxSize <= 0 || fb.PreviewMaxSize > maxPreviewMax {
		return fmt.Errorf("preview_max_size must be between 1 and %d bytes", maxPreviewMax)
	}
	if fb.BrowseLimit <= 0 || fb.BrowseLimit > maxBrowseLimit {
		return fmt.Errorf("browse_limit must be between 1 and %d", maxBrowseLimit)
	}
	for _, name := range fb.Readme {
		if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
			return fmt.Errorf("readme name %q must be a plain file name", name)
		}
	}
	return nil
}

// ServeHTTP implements caddyhttp.MiddlewareHandler.
func (fb *FileBrowser) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return next.ServeHTTP(w, r)
	}
	if fb.md == nil {
		fb.md = goldmark.New(
			goldmark.WithExtensions(extension.GFM),
			goldmark.WithParserOptions(parser.WithAutoHeadingID()),
		)
	}
	if fb.PreviewMaxSize <= 0 {
		fb.PreviewMaxSize = defaultPreviewMax
	}
	if fb.BrowseLimit <= 0 {
		fb.BrowseLimit = defaultBrowseMax
	}

	res, err := fb.resolve(r)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return next.ServeHTTP(w, r)
		}
		if errors.Is(err, os.ErrPermission) {
			return caddyhttp.Error(http.StatusForbidden, err)
		}
		if errors.Is(err, errOutsideRoot) {
			return caddyhttp.Error(http.StatusNotFound, os.ErrNotExist)
		}
		return next.ServeHTTP(w, r)
	}
	if fb.isHidden(res.rel) {
		return caddyhttp.Error(http.StatusNotFound, os.ErrNotExist)
	}

	if res.info.IsDir() {
		if !strings.HasSuffix(originalPath(r), "/") {
			target := originalPath(r) + "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			w.Header().Set("Location", target)
			w.WriteHeader(http.StatusPermanentRedirect)
			return nil
		}
		return fb.serveDir(w, r, res)
	}

	if r.URL.Query().Get(previewQuery) == previewValue {
		return fb.servePreview(w, r, res)
	}
	return fb.serveFile(w, r, res)
}

type resolved struct {
	root     string
	filename string
	rel      string
	info     os.FileInfo
}

var errOutsideRoot = errors.New("path escapes the configured root")

func originalPath(r *http.Request) string {
	if orig, ok := r.Context().Value(caddyhttp.OriginalRequestCtxKey).(http.Request); ok && orig.URL.Path != "" {
		return orig.URL.Path
	}
	return r.URL.Path
}

func (fb *FileBrowser) resolve(r *http.Request) (*resolved, error) {
	root := fb.Root
	if root == "" {
		root = "{http.vars.root}"
	}
	if repl, ok := r.Context().Value(caddy.ReplacerCtxKey).(*caddy.Replacer); ok {
		root = repl.ReplaceAll(root, ".")
	}
	if root == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	absRoot, err = filepath.EvalSymlinks(absRoot)
	if err != nil {
		return nil, err
	}
	filename := caddyhttp.SanitizedPathJoin(absRoot, r.URL.Path)
	resolvedName, err := filepath.EvalSymlinks(filename)
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(absRoot, resolvedName)
	if err != nil {
		return nil, err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, errOutsideRoot
	}
	info, err := os.Stat(resolvedName)
	if err != nil {
		return nil, err
	}
	rel = filepath.ToSlash(rel)
	if rel == "." {
		rel = ""
	}
	return &resolved{root: absRoot, filename: resolvedName, rel: rel, info: info}, nil
}

func (fb *FileBrowser) isHidden(rel string) bool {
	if rel == "" {
		return false
	}
	segments := strings.Split(rel, "/")
	for _, pattern := range fb.Hide {
		if pattern == "" {
			continue
		}
		if strings.Contains(pattern, "/") {
			if ok, _ := path.Match(pattern, rel); ok {
				return true
			}
			continue
		}
		for _, segment := range segments {
			if ok, _ := path.Match(pattern, segment); ok {
				return true
			}
		}
	}
	return false
}

func (fb *FileBrowser) serveFile(w http.ResponseWriter, r *http.Request, res *resolved) error {
	file, err := os.Open(res.filename)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return caddyhttp.Error(http.StatusForbidden, err)
		}
		return caddyhttp.Error(http.StatusNotFound, err)
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(res.info.Name()))
	if r.URL.Query().Get("download") == "1" || isUnsafeInline(ext) {
		w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(res.info.Name()))
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, res.info.Name(), res.info.ModTime(), file)
	return nil
}

func isUnsafeInline(ext string) bool {
	switch ext {
	case ".html", ".htm", ".xhtml", ".svg", ".xml", ".xsl", ".xslt":
		return true
	}
	return false
}

func (fb *FileBrowser) servePreview(w http.ResponseWriter, r *http.Request, res *resolved) error {
	payload, err := fb.previewPayload(r, res)
	if err != nil {
		return caddyhttp.Error(http.StatusInternalServerError, err)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodHead {
		return nil
	}
	return json.NewEncoder(w).Encode(payload)
}

type previewPayload struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	SizeLabel   string `json:"size_label"`
	Modified    string `json:"modified"`
	Kind        string `json:"kind"`
	Content     string `json:"content,omitempty"`
	HTML        string `json:"html,omitempty"`
	Truncated   bool   `json:"truncated,omitempty"`
	RawURL      string `json:"raw_url"`
	DownloadURL string `json:"download_url"`
	Message     string `json:"message,omitempty"`
}

func (fb *FileBrowser) previewPayload(r *http.Request, res *resolved) (*previewPayload, error) {
	name := res.info.Name()
	ext := strings.ToLower(filepath.Ext(name))
	href := escapeSegment(name)
	payload := &previewPayload{
		Name:        name,
		Path:        "/" + strings.TrimPrefix(path.Join("/", res.rel), "/"),
		Size:        res.info.Size(),
		SizeLabel:   humanize.Bytes(uint64(res.info.Size())),
		Modified:    res.info.ModTime().Format("2006-01-02 15:04"),
		RawURL:      href,
		DownloadURL: href + "?download=1",
	}

	kind := kindFromName(name)
	if ext == ".svg" {
		max := fb.PreviewMaxSize
		if max <= 0 {
			max = defaultPreviewMax
		}
		file, err := os.Open(res.filename)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, max+1))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > max {
			data = data[:max]
			payload.Truncated = true
			payload.Message = fmt.Sprintf("Preview limited to the first %s.", humanize.Bytes(uint64(max)))
		}
		if !isTextData(data) {
			payload.Kind = "binary"
			payload.Message = "This SVG is not valid text. Use the download button to open it."
			return payload, nil
		}
		payload.Kind = "image"
		payload.Content = string(data)
		return payload, nil
	}
	switch kind {
	case "image", "pdf", "video", "audio":
		payload.Kind = kind
		return payload, nil
	}

	max := fb.PreviewMaxSize
	if max <= 0 {
		max = defaultPreviewMax
	}
	file, err := os.Open(res.filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		data = data[:max]
		payload.Truncated = true
	}

	if !isTextData(data) {
		payload.Kind = "binary"
		payload.Message = "This file is binary. Use the download button to open it."
		return payload, nil
	}

	payload.Kind = "text"
	payload.Content = string(data)
	if kind == "markdown" {
		payload.Kind = "markdown"
		payload.HTML = string(fb.renderMarkdown(data))
	}
	if payload.Truncated {
		payload.Message = fmt.Sprintf("Preview limited to the first %s.", humanize.Bytes(uint64(max)))
	}
	return payload, nil
}

func (fb *FileBrowser) renderMarkdown(src []byte) template.HTML {
	var buf bytes.Buffer
	if err := fb.md.Convert(src, &buf); err != nil {
		return template.HTML("<p>Unable to render Markdown.</p>")
	}
	return template.HTML(sanitizer.SanitizeBytes(buf.Bytes()))
}

type crumb struct {
	Name    string
	Href    string
	Current bool
}

type entry struct {
	Name     string
	Href     string
	Kind     string
	Icon     string
	IsDir    bool
	Size     string
	Modified string
}

type readme struct {
	Name     string
	Href     string
	HTML     template.HTML
	TooLarge bool
	Size     string
}

type pageData struct {
	Title       string
	PathLabel   string
	Depth       int
	HomeURL     string
	UpURL       string
	Breadcrumbs []crumb
	Readme      *readme
	Entries     []entry
	Truncated   bool
	Version     string
	CSS         template.CSS
	JS          template.JS
}

func (fb *FileBrowser) serveDir(w http.ResponseWriter, r *http.Request, res *resolved) error {
	page, err := fb.buildPage(r, res)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return caddyhttp.Error(http.StatusForbidden, err)
		}
		return caddyhttp.Error(http.StatusInternalServerError, err)
	}
	var buf bytes.Buffer
	if err := pageTemplate.Execute(&buf, page); err != nil {
		return caddyhttp.Error(http.StatusInternalServerError, err)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
	if r.Method == http.MethodHead {
		return nil
	}
	_, err = w.Write(buf.Bytes())
	return err
}

func (fb *FileBrowser) buildPage(r *http.Request, res *resolved) (*pageData, error) {
	dirEntries, err := os.ReadDir(res.filename)
	if err != nil {
		return nil, err
	}

	entries := make([]entry, 0, len(dirEntries))
	var readmeFound bool
	var readmeFilename string
	for _, de := range dirEntries {
		name := de.Name()
		childRel := name
		if res.rel != "" {
			childRel = res.rel + "/" + name
		}
		if fb.isHidden(childRel) {
			continue
		}
		info, err := os.Stat(filepath.Join(res.filename, name))
		if err != nil {
			continue
		}
		if info.IsDir() {
			if escapesRoot(res.root, res.filename, name) {
				continue
			}
		} else if escapesRoot(res.root, res.filename, name) {
			continue
		}
		kind := kindFromName(name)
		icon := kind
		if info.IsDir() {
			kind = "dir"
			icon = "folder"
		}
		href := escapeSegment(name)
		if info.IsDir() {
			href += "/"
		}
		entries = append(entries, entry{
			Name:     name,
			Href:     href,
			Kind:     kind,
			Icon:     icon,
			IsDir:    info.IsDir(),
			Size:     sizeLabel(info),
			Modified: info.ModTime().Format("2006-01-02 15:04"),
		})
		if !info.IsDir() && !readmeFound && fb.matchesReadme(name) {
			readmeFilename = name
			readmeFound = true
		}
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})

	truncated := false
	if len(entries) > fb.BrowseLimit {
		entries = entries[:fb.BrowseLimit]
		truncated = true
	}

	depth := strings.Count(strings.Trim(res.rel, "/"), "/")
	if res.rel != "" {
		depth++
	}
	up := ""
	if depth > 0 {
		up = strings.Repeat("../", depth)
	}
	home := up
	if home == "" {
		home = "./"
	}

	page := &pageData{
		Title:       "Files",
		PathLabel:   "/" + res.rel,
		Depth:       depth,
		HomeURL:     home,
		UpURL:       up,
		Breadcrumbs: breadcrumbs(r.URL.Path, depth),
		Entries:     entries,
		Truncated:   truncated,
		Version:     moduleVersion,
		CSS:         template.CSS(cssText),
		JS:          template.JS(jsText),
	}
	if res.rel == "" {
		page.PathLabel = "/"
	}
	if res.rel != "" {
		page.Title = path.Base(res.rel)
	}
	if readmeFound {
		rm, err := fb.readReadme(res.filename, readmeFilename)
		if err == nil {
			page.Readme = rm
		}
	}
	return page, nil
}

func escapesRoot(root, dir, name string) bool {
	full := filepath.Join(dir, name)
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		return true
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil {
		return true
	}
	return rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (fb *FileBrowser) matchesReadme(name string) bool {
	for _, candidate := range fb.Readme {
		if strings.EqualFold(name, candidate) {
			return true
		}
	}
	return false
}

func (fb *FileBrowser) readReadme(dir, name string) (*readme, error) {
	full := filepath.Join(dir, name)
	info, err := os.Stat(full)
	if err != nil {
		return nil, err
	}
	rm := &readme{Name: name, Href: escapeSegment(name), Size: humanize.Bytes(uint64(info.Size()))}
	if info.Size() > fb.PreviewMaxSize {
		rm.TooLarge = true
		return rm, nil
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".md" || ext == ".markdown" {
		rm.HTML = fb.renderMarkdown(data)
	} else {
		rm.HTML = template.HTML("<pre class=\"readme-plain\">" + html.EscapeString(string(data)) + "</pre>")
	}
	return rm, nil
}

func breadcrumbs(urlPath string, depth int) []crumb {
	segments := strings.Split(strings.Trim(urlPath, "/"), "/")
	if len(segments) == 1 && segments[0] == "" {
		segments = nil
	}
	crumbs := make([]crumb, 0, len(segments)+1)
	crumbs = append(crumbs, crumb{
		Name:    "Files",
		Href:    strings.Repeat("../", depth),
		Current: len(segments) == 0,
	})
	if len(segments) == 0 {
		crumbs[0].Href = "./"
		return crumbs
	}
	for i, segment := range segments {
		if segment == "" {
			continue
		}
		levelsUp := len(segments) - i - 1
		href := strings.Repeat("../", levelsUp)
		if href == "" {
			href = "./"
		}
		crumbs = append(crumbs, crumb{
			Name:    segment,
			Href:    href,
			Current: i == len(segments)-1,
		})
	}
	return crumbs
}

func escapeSegment(name string) string {
	return url.PathEscape(name)
}

func sizeLabel(info os.FileInfo) string {
	if info.IsDir() {
		return "—"
	}
	return humanize.Bytes(uint64(info.Size()))
}

func kindFromName(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".md", ".markdown":
		return "markdown"
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg":
		return "image"
	case ".pdf":
		return "pdf"
	case ".mp4", ".webm", ".mkv", ".mov", ".m4v", ".ogv":
		return "video"
	case ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".opus":
		return "audio"
	case ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar":
		return "archive"
	case ".go", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".rs",
		".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".swift",
		".sh", ".bash", ".zsh", ".fish", ".ps1", ".lua", ".sql", ".css", ".scss",
		".sass", ".less", ".vue", ".svelte", ".astro", ".nix", ".tf", ".hcl",
		".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".config", ".xml",
		".html", ".htm", ".proto", ".graphql", ".gql", ".dockerfile":
		return "code"
	case ".txt", ".log", ".csv", ".tsv", ".rst", ".adoc", ".tex", ".env", ".gitignore":
		return "text"
	}
	if name == "Dockerfile" || name == "Makefile" || name == "Caddyfile" || name == "LICENSE" || name == "NOTICE" {
		return "code"
	}
	if mt := mime.TypeByExtension(ext); strings.HasPrefix(mt, "text/") {
		return "text"
	}
	return "file"
}

func isTextData(data []byte) bool {
	if len(data) == 0 {
		return true
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return false
	}
	return true
}

// Interface guards.
var (
	_ caddy.Provisioner           = (*FileBrowser)(nil)
	_ caddy.Validator             = (*FileBrowser)(nil)
	_ caddyhttp.MiddlewareHandler = (*FileBrowser)(nil)
	_ caddyfile.Unmarshaler       = (*FileBrowser)(nil)
)
