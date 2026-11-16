# caddy-github-browse demo


This directory is served by Caddy's stock **file_server** with the
**caddy-github-browse** browse template.

## What to try

- Click `build.sh` to open the preview dialog with syntax highlighting.
- Click `notes.md` to preview rendered Markdown.
- Click `image.svg` to see the image inside the dialog.
- Click a directory to navigate.
- Use the List / Grid switch and the search box above.

> The README is rendered in the browser with marked, sanitized with DOMPurify,
> and code is highlighted with highlight.js.

```bash
curl -fsSL https://example.com/build.sh | bash
```

```go
package main

import "fmt"

func main() {
    fmt.Println("hello from caddy-github-browse")
}
```

```json
{
  "server": "caddy",
  "handler": "file_server",
  "browse": "browse.html"
}
```

The rest of this page is the stock Caddy file listing, not a custom server.
