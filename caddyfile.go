package filebrowser

import (
	"strconv"

	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/dustin/go-humanize"
)

func parseCaddyfile(h httpcaddyfile.Helper) (caddyhttp.MiddlewareHandler, error) {
	fb := new(FileBrowser)
	if err := fb.UnmarshalCaddyfile(h.Dispenser); err != nil {
		return nil, err
	}
	return fb, nil
}

// UnmarshalCaddyfile parses:
//
//	filebrowser {
//	    root              <path>
//	    hide              <names/patterns...>
//	    readme            <file names...>
//	    preview_max_size  <size>
//	    browse_limit      <n>
//	}
//
// The root defaults to the site root set by the Caddyfile `root` directive.
// `hide` with no arguments disables all hiding; `readme` with no arguments is
// an error because that would disable the README card unintentionally.
func (fb *FileBrowser) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	d.Next() // consume directive name
	if d.NextArg() {
		return d.ArgErr()
	}

	hideSeen := false
	readmeSeen := false
	for nesting := d.Nesting(); d.NextBlock(nesting); {
		switch d.Val() {
		case "root":
			if !d.NextArg() {
				return d.ArgErr()
			}
			fb.Root = d.Val()
			if d.NextArg() {
				return d.ArgErr()
			}

		case "hide":
			if !hideSeen {
				fb.Hide = []string{}
				hideSeen = true
			}
			for _, name := range d.RemainingArgs() {
				if name == "" {
					return d.Err("hide pattern cannot be empty")
				}
				fb.Hide = append(fb.Hide, name)
			}

		case "readme":
			args := d.RemainingArgs()
			if len(args) == 0 {
				return d.Err("readme requires at least one file name")
			}
			if !readmeSeen {
				fb.Readme = []string{}
				readmeSeen = true
			}
			for _, name := range args {
				if name == "" {
					return d.Err("readme name cannot be empty")
				}
				fb.Readme = append(fb.Readme, name)
			}

		case "preview_max_size":
			if !d.NextArg() {
				return d.ArgErr()
			}
			size, err := humanize.ParseBytes(d.Val())
			if err != nil {
				return d.Errf("parsing preview_max_size: %v", err)
			}
			fb.PreviewMaxSize = int64(size)
			if d.NextArg() {
				return d.ArgErr()
			}

		case "browse_limit":
			if !d.NextArg() {
				return d.ArgErr()
			}
			limit, err := strconv.Atoi(d.Val())
			if err != nil || limit <= 0 {
				return d.Errf("browse_limit must be a positive integer, got %q", d.Val())
			}
			fb.BrowseLimit = limit
			if d.NextArg() {
				return d.ArgErr()
			}

		default:
			return d.Errf("unrecognized filebrowser option %q", d.Val())
		}
	}
	return nil
}
