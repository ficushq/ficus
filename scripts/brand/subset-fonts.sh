#!/usr/bin/env bash
# Rebuilds brand/fonts/subset/*.woff2, the small font files the social preview
# SVGs embed, from the OFL source fonts committed in brand/fonts/.
#
# Dev-only: needs fonttools with brotli on PATH (`pip install fonttools brotli`).
# Nothing in the repo installs it, and `bun run brand:generate` only reads the
# committed subsets, so this only needs re-running when the sources or the
# character set below change.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fonts="$root/brand/fonts"
out="$fonts/subset"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

# fonttools stamps head.modified with the current time unless this is set;
# pin it so re-running the script reproduces the committed files byte-for-byte.
export SOURCE_DATE_EPOCH=0

# Basic Latin plus the typographic punctuation the cards use (’ ‘ “ ” – — · • … → ✓).
unicodes="U+0020-007E,U+00A0,U+00B7,U+2018,U+2019,U+201C,U+201D,U+2013,U+2014,U+2022,U+2026,U+2192,U+2713"

# Fraunces: upright, semibold (600), SOFT/WONK at the defaults Google Fonts
# serves, optical size kept variable (40–144) so the browser sizes it.
fonttools varLib.instancer --quiet -o "$tmp/fraunces.ttf" \
  "$fonts/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf" wght=600 SOFT=0 WONK=1 opsz=40:144
# Instrument Sans: normal width, weight kept variable (400–700).
fonttools varLib.instancer --quiet -o "$tmp/instrument-sans.ttf" \
  "$fonts/instrument-sans/InstrumentSans[wdth,wght].ttf" wdth=100

for name in fraunces instrument-sans; do
  pyftsubset "$tmp/$name.ttf" \
    --unicodes="$unicodes" \
    --layout-features='kern,liga,calt,rvrn,ccmp,locl,mark,mkmk' \
    --flavor=woff2 \
    --no-hinting \
    --desubroutinize \
    --output-file="$out/$name.woff2"
done
ls -l "$out"
