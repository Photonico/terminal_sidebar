# Terminal Sidebar logo

- `logo.svg`: 512 × 512 vector master, transparent background, outlined glyphs.
- `logo.eps`: 384 × 384 pt vector EPS export, with the same proportions and margins as the SVG. The background and frame interior are unpainted; EPS does not store an alpha channel.
- `logo.png`: 512 × 512 RGBA export for extension packaging and previews.

The circular frame consists of twelve white dashes with rounded ends, rotated three degrees clockwise. Each dash occupies 22 degrees of visible ink, followed by an 8-degree transparent gap, measured along the circle's 194-unit centreline radius. Each visible segment is ten per cent longer than the previous 20-degree design. The generator compensates for the round caps, including their grey outline, so the stated lengths describe the visible result.

The frame retains its nominal 28-unit body width. The `>_` prompt is heavier, with a nominal body width of 34 units. Both have a centred `#646464` outline 6 units wide: the frame's visible white band is 22 units wide, while the prompt's is 28 units. Their complete outlined widths are 34 and 40 units respectively.

Each glyph moves ten canvas units towards the centre of the circle. The font, original contours, scale of 0.137, proportions, and orientation remain unchanged. Translation brings the characters slightly closer together; two layered strokes add weight without substituting a bold font or stretching the glyphs.

The glyphs come from the project owner's **Photonico Code Regular** font (internal version 1.4), used with permission and converted to paths. The original font file is not included and is not needed to display the logo. SVG and EPS contain vector paths, with no embedded font or raster image.

These logo assets and the generator are included under the repository's [MIT licence](../LICENSE). The original font file remains subject to its own licence and is not redistributed here.

To regenerate with the original font:

```sh
python -m pip install fonttools cairosvg
python scripts/generate_logo.py /path/to/Photonico-Code-Regular.ttf
```

CairoSVG requires the Cairo graphics library. Regeneration is an optional design step, not an extension runtime dependency.
