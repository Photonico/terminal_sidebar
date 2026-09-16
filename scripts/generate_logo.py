#!/usr/bin/env python3
"""Build the outlined Photonico Code logo without embedding the font file.

Usage: python scripts/generate_logo.py /path/to/Photonico-Code-Regular.ttf
Dependencies: fonttools, cairosvg (with system Cairo).
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from xml.sax.saxutils import escape

import cairosvg
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont


def circle_path(cx: float, cy: float, radius: float) -> str:
    return (
        f"M{cx + radius:g} {cy:g}"
        f"A{radius:g} {radius:g} 0 1 0 {cx - radius:g} {cy:g}"
        f"A{radius:g} {radius:g} 0 1 0 {cx + radius:g} {cy:g}Z"
    )


def build(font_path: Path, output: Path) -> None:
    font_bytes = font_path.read_bytes()
    with TTFont(font_path) as font:
        family = font['name'].getDebugName(1) or ''
        version = font['name'].getDebugName(5) or ''
        if family != 'Photonico Code':
            raise ValueError(f"Expected Photonico Code, received {family!r}")

        glyph_set = font.getGlyphSet()
        cmap = font.getBestCmap()
        glyphs: list[tuple[str, float]] = []
        bounds = []
        advance = 0
        for index, character in enumerate('>_'):
            if index:
                # Tighten the two-character lockup without stretching the glyphs.
                advance -= 170
            name = cmap[ord(character)]
            pen = BoundsPen(glyph_set)
            glyph_set[name].draw(TransformPen(pen, (1, 0, 0, 1, advance, 0)))
            if pen.bounds is None:
                raise ValueError(f"No outline for {character!r}")
            bounds.append(pen.bounds)
            glyphs.append((name, advance))
            advance += font['hmtx'][name][0]

        xmin = min(b[0] for b in bounds)
        ymin = min(b[1] for b in bounds)
        xmax = max(b[2] for b in bounds)
        ymax = max(b[3] for b in bounds)
        # Keep the original glyph size while reducing the overall letter spacing.
        scale = 0.137
        dx = 256 - (xmin + xmax) * scale / 2
        dy = 256 + (ymin + ymax) * scale / 2
        path_pen = SVGPathPen(glyph_set, ntos=lambda v: f'{v:.4f}'.rstrip('0').rstrip('.') if v else '0')
        for name, position in glyphs:
            glyph_set[name].draw(TransformPen(path_pen, (scale, 0, 0, -scale, dx + position * scale, dy)))
        glyph_path = path_pen.getCommands()

    ring = circle_path(256, 256, 208) + circle_path(256, 256, 180)
    outline_width = 6
    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="title description">
  <title id="title">Terminal Sidebar</title>
  <desc id="description">White circular frame and tightly spaced Photonico Code greater-than and underscore glyphs, with matching #646464 outlines on a transparent background.</desc>
  <metadata>Glyph source: {escape(family)} Regular, {escape(version)}. Font SHA-256: {hashlib.sha256(font_bytes).hexdigest()}. Glyphs converted to paths; no embedded font.</metadata>
  <g fill="#ffffff" stroke="#646464" stroke-width="{outline_width}" stroke-linejoin="round">
    <path id="frame" d="{ring}" fill-rule="evenodd"/>
    <path id="prompt" d="{glyph_path}"/>
  </g>
</svg>
'''
    output.mkdir(parents=True, exist_ok=True)
    (output / 'logo.svg').write_text(svg, encoding='utf-8')
    eps = cairosvg.svg2eps(bytestring=svg.encode()).decode('ascii')
    # Cairo uses the ink bounds for EPS. Preserve the SVG's transparent margins:
    # 512 CSS pixels at 96 dpi correspond to 384 PostScript points at 72 dpi.
    eps_lines = []
    for line in eps.splitlines():
        if line.startswith('%%BoundingBox:'):
            line = '%%BoundingBox: 0 0 384 384'
        elif line.startswith('%%PageBoundingBox:'):
            line = '%%PageBoundingBox: 0 0 384 384'
        elif line.startswith('%%CreationDate:'):
            continue  # Keep regeneration independent of the local clock.
        eps_lines.append(line)
    (output / 'logo.eps').write_text('\n'.join(eps_lines) + '\n', encoding='ascii')
    cairosvg.svg2png(bytestring=svg.encode(), write_to=str(output / 'logo.png'), output_width=512, output_height=512)
    print(f'Created logo.svg, logo.eps, logo.png in {output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('font', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'assets')
    args = parser.parse_args()
    build(args.font.expanduser(), args.output)
