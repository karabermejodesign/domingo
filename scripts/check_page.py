#!/usr/bin/env python3
"""Standing checks for a self-contained SPA in public/<name>/index.html.

Usage:
  python3 scripts/check_page.py public/cook/index.html --root public [--base /cook]

What it does (Kara's post-update rule):
  1. Images aren't broken: finds every src=, url(), srcset and JS string that
     looks like an image/asset path and verifies the file exists under --root.
     Relative paths are reported as errors because Vercel serves
     public/<dir>/index.html at the extensionless /<dir>, so "img/x.png"
     resolves against the site root in production and 404s.
  2. No syntax errors: extracts every inline <script> block (no src, no
     type="application/json"/"text/*") and runs `node --check` on it.

Exit code 0 when everything passes, 1 otherwise. Output is a short report.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile

ASSET_EXT = r"(?:png|jpe?g|webp|gif|svg|avif|ico|mp3|mp4|webm|woff2?|ttf|otf|json|pdf)"


def find_paths(html: str):
    found = set()
    for m in re.finditer(r"""(?:src|href|poster)\s*=\s*["']([^"']+)["']""", html):
        found.add(m.group(1))
    for m in re.finditer(r"""srcset\s*=\s*["']([^"']+)["']""", html):
        for part in m.group(1).split(","):
            found.add(part.strip().split()[0])
    for m in re.finditer(r"""url\(\s*["']?([^"')]+)["']?\s*\)""", html):
        found.add(m.group(1))
    # JS-built paths: any quoted string that ends in an asset extension
    for m in re.finditer(r"""["'`]([^"'`\s]+\.%s)(?:\?[^"'`]*)?["'`]""" % ASSET_EXT, html):
        found.add(m.group(1))
    return sorted(p for p in found if p and not p.startswith(("#", "mailto:", "tel:")))


def is_external(p: str):
    return p.startswith(("http://", "https://", "//", "data:", "blob:"))


def check_assets(html, root, base):
    errors, ok = [], 0
    for p in find_paths(html):
        if is_external(p):
            continue
        if not re.search(r"\.%s(\?|$)" % ASSET_EXT, p):
            continue  # links to routes, not files
        clean = p.split("?")[0].split("#")[0]
        if not clean.startswith("/"):
            errors.append(f"RELATIVE path (will 404 in production at {base}): {p}")
            continue
        target = os.path.join(root, clean.lstrip("/"))
        if os.path.isfile(target):
            ok += 1
        else:
            errors.append(f"MISSING under {root}: {p}")
    return ok, errors


SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.S | re.I)


def check_scripts(html):
    errors, n = [], 0
    for m in SCRIPT_RE.finditer(html):
        attrs, body = m.group(1), m.group(2)
        if re.search(r"\bsrc\s*=", attrs):
            continue
        t = re.search(r"""type\s*=\s*["']([^"']+)""", attrs)
        if t and not re.search(r"javascript|module|ecmascript", t.group(1), re.I):
            continue
        if not body.strip():
            continue
        n += 1
        with tempfile.NamedTemporaryFile("w", suffix=".mjs" if (t and "module" in t.group(1)) else ".js",
                                         delete=False, encoding="utf8") as f:
            f.write(body)
            path = f.name
        try:
            r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
            if r.returncode != 0:
                lines = [l for l in r.stderr.splitlines()
                         if l.strip() and not l.startswith(("Node.js", "    at ", path))]
                msg = next((l for l in lines if "Error" in l), lines[0] if lines else "syntax error")
                errors.append(f"script #{n}: {msg.strip()}")
        finally:
            os.unlink(path)
    return n, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("page")
    ap.add_argument("--root", default="public", help="folder Vercel serves as site root")
    ap.add_argument("--base", default=None, help="route the page serves at, e.g. /cook")
    a = ap.parse_args()
    html = open(a.page, encoding="utf8").read()
    base = a.base or "/" + os.path.basename(os.path.dirname(os.path.abspath(a.page)))

    ok, aerr = check_assets(html, a.root, base)
    n, serr = check_scripts(html)
    print(f"assets: {ok} ok, {len(aerr)} problems")
    for e in aerr:
        print("  - " + e)
    print(f"scripts: {n} inline block(s) checked, {len(serr)} problems")
    for e in serr:
        print("  - " + e)
    sys.exit(1 if (aerr or serr) else 0)


if __name__ == "__main__":
    main()
