#!/usr/bin/env python3
"""Build the Terminal Sidebar logo from the owner's Photonico Code outlines.

Usage: python scripts/generate_logo.py /path/to/Photonico-Code-Regular.ttf
Dependencies: fonttools, cairosvg (with system Cairo).

Geometry uses a 512-unit square canvas. SVG and PNG retain transparency;
EPS leaves the same areas unpainted rather than storing an alpha channel.
"""

from __future__ import annotations

import argparse
import hashlib
import math
from pathlib import Path
from xml.sax.saxutils import escape

import cairosvg
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont


def format_number(value: float) -> str:
    """Return SVG coordinates with four decimal places at most."""
    if value == 0:
        return '0'
    return f'{value:.4f}'.rstrip('0').rstrip('.')


def circle_point(radius: float, angle: float) -> str:
    """Return a point about (256, 256); angle is measured in radians."""
    horizontal = 256 + radius * math.cos(angle)
    vertical = 256 + radius * math.sin(angle)
    return f'{format_number(horizontal)} {format_number(vertical)}'


def circular_dash_path(radius: float, body_width: float, start: float, end: float) -> str:
    """Return a closed annular dash with semicircular ends, before outlining.

    Radius and body_width use canvas units. Start and end are centreline
    angles in radians, increasing clockwise in the SVG coordinate system.
    """
    half_width = body_width / 2
    outside_radius = radius + half_width
    inside_radius = radius - half_width
    return (
        f'M{circle_point(outside_radius, start)}'
        f'A{outside_radius:g} {outside_radius:g} 0 0 1 {circle_point(outside_radius, end)}'
        f'A{half_width:g} {half_width:g} 0 0 1 {circle_point(inside_radius, end)}'
        f'A{inside_radius:g} {inside_radius:g} 0 0 0 {circle_point(inside_radius, start)}'
        f'A{half_width:g} {half_width:g} 0 0 1 {circle_point(outside_radius, start)}Z'
    )


def circular_dashes(radius: float, body_width: float, outline_width: float) -> list[str]:
    """Build 12 longer dashes, rotated three degrees clockwise.

    Each 30-degree interval contains 22 degrees of visible ink and 8 degrees
    of transparent gap. A round cap, including the grey outline, extends
    beyond the underlying arc. Its angular reach on the reference circle is
    2 * asin(cap_radius / (2 * radius)); subtract both ends before drawing.
    This preserves the visible ratio instead of setting a naive dash array.
    """
    number_of_dashes = 12
    interval_angle = 2 * math.pi / number_of_dashes
    visible_dash_angle = math.radians(22)
    rotation_angle = math.radians(3)
    outside_cap_radius = (body_width + outline_width) / 2
    cap_angle = 2 * math.asin(outside_cap_radius / (2 * radius))
    arc_angle = visible_dash_angle - 2 * cap_angle
    if arc_angle <= 0:
        raise ValueError('The ring is too thick for 12 separate rounded dashes.')

    paths = []
    for index in range(number_of_dashes):
        # Offset twelve o'clock clockwise, then repeat every thirty degrees.
        centre_angle = -math.pi / 2 + rotation_angle + index * interval_angle
        start_angle = centre_angle - arc_angle / 2
        end_angle = centre_angle + arc_angle / 2
        paths.append(circular_dash_path(radius, body_width, start_angle, end_angle))
    return paths


def build_logo(font_path: Path, output: Path) -> None:
    """Write SVG, vector EPS and 512-pixel PNG from the same source geometry."""
    # Scale the complete prompt, including its spacing and layered strokes.
    prompt_scale = 0.9
    font_bytes = font_path.read_bytes()
    with TTFont(font_path) as font:
        family = font['name'].getDebugName(1) or ''
        version = font['name'].getDebugName(5) or ''
        if family != 'Photonico Code':
            raise ValueError(f'Expected Photonico Code, received {family!r}')

        glyph_set = font.getGlyphSet()
        character_map = font.getBestCmap()
        positioned_glyphs: list[tuple[str, float]] = []
        glyph_bounds = []
        horizontal_advance = 0
        for index, character in enumerate('>_'):
            if index:
                horizontal_advance -= 170
            glyph_name = character_map[ord(character)]
            bounds_pen = BoundsPen(glyph_set)
            glyph_set[glyph_name].draw(TransformPen(bounds_pen, (1, 0, 0, 1, horizontal_advance, 0)))
            if bounds_pen.bounds is None:
                raise ValueError(f'No outline for {character!r}')
            glyph_bounds.append(bounds_pen.bounds)
            positioned_glyphs.append((glyph_name, horizontal_advance))
            horizontal_advance += font['hmtx'][glyph_name][0]

        minimum_x = min(bounds[0] for bounds in glyph_bounds)
        minimum_y = min(bounds[1] for bounds in glyph_bounds)
        maximum_x = max(bounds[2] for bounds in glyph_bounds)
        maximum_y = max(bounds[3] for bounds in glyph_bounds)
        glyph_scale = 0.137 * prompt_scale
        horizontal_offset = 256 - (minimum_x + maximum_x) * glyph_scale / 2
        vertical_offset = 256 + (minimum_y + maximum_y) * glyph_scale / 2
        outline_pen = SVGPathPen(glyph_set, ntos=format_number)
        prompt_inset = 10 * prompt_scale
        for (glyph_name, position), bounds in zip(positioned_glyphs, glyph_bounds):
            # Preserve the original inward translation under uniform scaling.
            centre_x = horizontal_offset + (bounds[0] + bounds[2]) * glyph_scale / 2
            centre_y = vertical_offset - (bounds[1] + bounds[3]) * glyph_scale / 2
            distance_to_centre = math.hypot(256 - centre_x, 256 - centre_y)
            inset_fraction = min(1, prompt_inset / distance_to_centre) if distance_to_centre else 0
            inset_x = (256 - centre_x) * inset_fraction
            inset_y = (256 - centre_y) * inset_fraction
            transform = (
                glyph_scale, 0, 0, -glyph_scale,
                horizontal_offset + position * glyph_scale + inset_x,
                vertical_offset + inset_y,
            )
            glyph_set[glyph_name].draw(TransformPen(outline_pen, transform))
        prompt_path = outline_pen.getCommands()
        underscore_bounds = glyph_bounds[1]
        original_body_width = (underscore_bounds[3] - underscore_bounds[1]) * glyph_scale

    prompt_body_width = 34 * prompt_scale
    outline_width = 6 * prompt_scale
    ring_body_width = prompt_body_width
    # Keep the previous frame's inner ink edge fixed and add weight outwards.
    # Both frame and prompt now have 25.2 units of white and 36 units overall.
    ring_inner_radius = 194 - (28 + 6) / 2
    ring_radius = ring_inner_radius + (ring_body_width + outline_width) / 2
    # Add weight to the original font outline with layered strokes.
    # No replacement font, outline redrawing, or non-uniform scaling is used.
    added_glyph_width = prompt_body_width - original_body_width
    grey_glyph_stroke = added_glyph_width + outline_width
    white_glyph_stroke = added_glyph_width - outline_width
    if white_glyph_stroke < 0:
        raise ValueError('This font weight is too heavy for the outlined prompt geometry.')

    dash_paths = circular_dashes(ring_radius, ring_body_width, outline_width)
    frame_elements = '\n'.join(
        f'    <path id="frame-dash-{index:02d}" d="{path}"/>'
        for index, path in enumerate(dash_paths)
    )
    font_hash = hashlib.sha256(font_bytes).hexdigest()
    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="title description">
  <title id="title">Terminal Sidebar</title>
  <desc id="description">Twelve rounded white circular dashes, rotated three degrees clockwise, surround Photonico Code greater-than and underscore glyphs reduced ten per cent around the centre. Matching line weights and #646464 outlines, with a transparent background.</desc>
  <metadata>Glyph source: {escape(family)} Regular, {escape(version)}. Font SHA-256: {font_hash}. Original glyph contours at scale {format_number(glyph_scale)}, each translated {format_number(prompt_inset)} units towards the centre. Complete prompt scaled by {format_number(prompt_scale)} from the previous design. Frame and prompt nominal bodies: {format_number(prompt_body_width)} units; grey borders: {format_number(outline_width)} units; complete widths: {format_number(prompt_body_width + outline_width)} units. Frame inner radius remains {format_number(ring_inner_radius)}; outer radius grows to {format_number(ring_radius + (ring_body_width + outline_width) / 2)}. Twelve dashes: visible 22-degree ink and 8-degree gap on radius {format_number(ring_radius)}, with round-cap outline compensation and 3-degree clockwise rotation. No embedded font.</metadata>
  <g id="frame" fill="#ffffff" stroke="#646464" stroke-width="{outline_width}" stroke-linejoin="round">
{frame_elements}
  </g>
  <g id="prompt" stroke-linejoin="round" stroke-linecap="round">
    <path id="prompt-outline" d="{prompt_path}" fill="#646464" stroke="#646464" stroke-width="{format_number(grey_glyph_stroke)}"/>
    <path id="prompt-body" d="{prompt_path}" fill="#ffffff" stroke="#ffffff" stroke-width="{format_number(white_glyph_stroke)}"/>
  </g>
</svg>
'''
    output.mkdir(parents=True, exist_ok=True)
    (output / 'logo.svg').write_text(svg, encoding='utf-8')
    eps_source = cairosvg.svg2eps(bytestring=svg.encode()).decode('ascii')
    # Preserve the complete transparent margins: 512 CSS pixels = 384 pt.
    eps_lines = []
    for line in eps_source.splitlines():
        if line.startswith('%%BoundingBox:'):
            line = '%%BoundingBox: 0 0 384 384'
        elif line.startswith('%%PageBoundingBox:'):
            line = '%%PageBoundingBox: 0 0 384 384'
        elif line.startswith('%%CreationDate:'):
            continue
        eps_lines.append(line.rstrip())
    (output / 'logo.eps').write_text('\n'.join(eps_lines) + '\n', encoding='ascii')
    cairosvg.svg2png(bytestring=svg.encode(), write_to=str(output / 'logo.png'), output_width=512, output_height=512)
    print(f'Created logo.svg, logo.eps, logo.png in {output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('font', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'assets')
    arguments = parser.parse_args()
    build_logo(arguments.font.expanduser(), arguments.output)
