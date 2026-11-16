#!/usr/bin/env python3
"""Build the single-file Caddy browse template from the vendored parts."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
base = (ROOT / "template" / "browse.base.html").read_text(encoding="utf-8")
custom_css = (ROOT / "template" / "custom.css").read_text(encoding="utf-8")
custom_js = (ROOT / "template" / "custom.js").read_text(encoding="utf-8")
highlight_js = (ROOT / "assets" / "highlight.min.js").read_text(encoding="utf-8")
marked_js = (ROOT / "assets" / "marked.min.js").read_text(encoding="utf-8")
purify_js = (ROOT / "assets" / "purify.min.js").read_text(encoding="utf-8")

old_csp = "{{ $csp := printf \"default-src 'none'; img-src 'self'; object-src 'none'; base-uri 'none'; script-src 'nonce-%s'; style-src 'nonce-%s'; frame-ancestors 'self'; form-action 'self';\" $nonce $nonce -}}"
new_csp = "{{ $csp := printf \"default-src 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'; script-src 'nonce-%s'; style-src 'nonce-%s'; connect-src 'self'; media-src 'self'; frame-src 'self'; frame-ancestors 'self'; form-action 'self';\" $nonce $nonce -}}"
if old_csp not in base:
    raise SystemExit("stock CSP line not found; update the template base")
base = base.replace(old_csp, new_csp, 1)

for name, content in [
    ("highlight.js", highlight_js),
    ("marked", marked_js),
    ("DOMPurify", purify_js),
    ("custom.js", custom_js),
    ("style.css", custom_css),
]:
    if "</script" in content and name not in ("style.css",):
        raise SystemExit(f"{name} contains </script")

addition = f"""
<!-- caddy-github-browse additions. Vendored libraries keep their license headers. -->
<style {{{{ $nonceAttribute }}}}>
{custom_css}
</style>
<script {{{{ $nonceAttribute }}}}>
{highlight_js}
</script>
<script {{{{ $nonceAttribute }}}}>
{marked_js}
</script>
<script {{{{ $nonceAttribute }}}}>
{purify_js}
</script>
<script {{{{ $nonceAttribute }}}}>
{custom_js}
</script>
"""
if "</body>" not in base:
    raise SystemExit("closing body not found")
base = base.replace("</body>", addition + "</body>", 1)
base = "\n".join(line.rstrip() for line in base.splitlines()) + "\n"
(ROOT / "browse.html").write_text(base, encoding="utf-8")
print(f"wrote browse.html ({len(base)} bytes)")
