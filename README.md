# caddy-filebrowser

A Caddy v2 file-server module with a GitHub-style README and an in-page file preview dialog.

Instead of a directory listing that navigates straight to every file, `filebrowser`
renders the current directory's README and opens text, code, Markdown, images, PDF,
audio and video in a focused preview dialog. Normal links still work with JavaScript
disabled.

![Directory listing with rendered README](docs/listing.png)

![File preview dialog](docs/preview.png)

## Features

- Rendered `README.md` / `README.markdown` / `README` card above the listing
- File preview dialog with Rendered / Source tabs for Markdown
- Text and code preview with a server-enforced size limit
- Image, PDF, audio and video previews
- Direct file URLs still work for sharing and downloads
- Breadcrumbs, parent navigation, file type icons, sizes and timestamps
- Client-side file filter
- Light and dark themes, responsive layout
- Hidden-file patterns, symlink-escape protection and Markdown HTML sanitization
- No external JS/CSS/CDN dependencies; everything is embedded in the Caddy binary
- Single-purpose Caddy module: no database, no uploads, no runtime configuration files

## Install

Build Caddy with xcaddy:

```bash
xcaddy build --with github.com/MinimaxFlora/caddy-filebrowser
```

To pin a version:

```bash
xcaddy build v2.11.9 \
  --with github.com/MinimaxFlora/caddy-filebrowser@v0.1.0
```

## Caddyfile

Replace `file_server` with `filebrowser`:

```caddyfile
http:// {
    root * /usr/share/caddy
    filebrowser
    encode gzip
}
```

The root defaults to the site root set by the `root` directive, so the common
Caddy file-server configuration only needs the handler name changed.

With options:

```caddyfile
files.example.com {
    root * /srv/files
    filebrowser {
        preview_max_size 2MiB
        browse_limit 5000
        hide .git .env node_modules
        readme README.md README.markdown README
    }
    encode gzip
}
```

If you keep `file_server` in the same route, `filebrowser` runs first because it is
ordered before `file_server`; files handled by `filebrowser` never reach the default
file server. Removing `file_server` is recommended to avoid two file-serving
handlers with different settings.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `root` | `{http.vars.root}` | Directory to serve. Supports Caddy placeholders. |
| `hide` | `.git .env .DS_Store Thumbs.db node_modules __pycache__` | Names or `path.Match` patterns hidden from the listing and blocked from direct access. `hide` with no arguments disables hiding. |
| `readme` | `README.md README.markdown README readme.md` | File names checked in order for the README card. Matching is case-insensitive. |
| `preview_max_size` | `1MiB` | Maximum bytes read for README and text previews. Larger files can still be downloaded. Maximum 64 MiB. |
| `browse_limit` | `10000` | Maximum entries rendered in one directory. Maximum 100000. |

## Behavior

- A directory URL without a trailing slash redirects to the slash form.
- Links in the listing are relative, so the module also works behind `handle_path`.
- Text/JSON preview is served from the same file URL with `?__fb=preview`; this is an
  internal endpoint used by the dialog and returns JSON.
- `?download=1` forces `Content-Disposition: attachment`.
- HTML, XHTML, SVG and XML files are served as attachments by default to avoid
  executing untrusted markup on the serving origin. They can still be previewed as
  text inside the dialog.
- Markdown is rendered with Goldmark (GFM) and sanitized with Bluemonday's UGC
  policy. Raw HTML in a README is not rendered.
- Files reached through symlinks are only served when the resolved target remains
  inside the configured root.
- With JavaScript disabled, the README is still rendered and file links open
  directly. The preview dialog requires JavaScript.

## Security notes

This module is a read-only file browser. It does not provide authentication,
upload, edit or delete functions. If the directory is not meant to be public, put
Caddy authentication in front of it:

```caddyfile
files.example.com {
    basic_auth {
        alice $2a$14$...hash...
    }
    root * /srv/files
    filebrowser
}
```

The directory being served must contain only content you are willing to publish.
The default hidden list is a convenience, not a security boundary; use filesystem
permissions and authentication for sensitive data.

## Why not an existing plugin?

At the time of writing:

- `filebrowser/caddy` is a Caddy v1 plugin and is archived.
- `glowinthedark/caddy-file-server-browse-extension` is a custom `browse.html`
  template, not a Caddy module; it does not add a README card.
- `synapticloop/caddy_media_gallery` is a Caddy v2 module, but it only provides a
  media lightbox, not README rendering or text/code preview.

`caddy-filebrowser` combines those ideas in a focused Caddy v2 module.

## Development

```bash
go test ./...
go vet ./...
xcaddy build v2.11.9 --with github.com/MinimaxFlora/caddy-filebrowser=.
./caddy run --config testdata/Caddyfile --adapter caddyfile
# open http://127.0.0.1:18080/
```

`testdata/` contains a small demo tree and a Caddyfile for local testing.

## License

Apache-2.0. See [LICENSE](LICENSE).
