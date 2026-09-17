# Terminal Sidebar logo

- `logo.svg`: 512 × 512 vector master, transparent background, outlined glyphs.
- `logo.eps`: 384 × 384 pt vector EPS export, with the same proportions and margins as the SVG. The background and frame interior are unpainted; EPS does not store an alpha channel.
- `logo.png`: 512 × 512 RGBA export for extension packaging and previews.
- `activity-icon.svg`: monochrome mask for both sidebar icons, based on the logo with heavier strokes for small-size legibility and tinted by VS Code's theme.

The circular frame consists of twelve white dashes with rounded ends, rotated three degrees clockwise. Each dash occupies 22 degrees of visible ink, followed by an 8-degree transparent gap, measured along the circle's 195-unit centreline radius. The generator compensates for the round caps, including their grey outline, so the stated lengths describe the visible result.

The frame and `>_` prompt share the same line weight: a nominal 30.6-unit body, a 25.2-unit visible white band, and a complete outlined width of 36 units. Their `#646464` borders are 5.4 units wide. The frame's inner ink radius remains 177 units; its outer radius increases from 211 to 213 units, adding thickness only outwards.

The entire prompt is ten per cent smaller than the previous design, uniformly scaled about the canvas centre (256, 256), including its spacing and stroke thickness. The original font contours use a scale of 0.1233, and each glyph's inward translation scales from ten to nine canvas units. Proportions and orientation remain unchanged; two layered strokes add weight without substituting a bold font or stretching the glyphs.

Only the `>_` prompt is then translated down by 10.24 units (2% of the 512-unit canvas height). The full-size logo's frame is unchanged.

The sidebar mask uses the same glyph contours and translation, with a 45-unit line weight for both the prompt and frame (25% heavier than the full logo, or about 2.11px at 24px). Its frame centreline moves out by 9 units to radius 204, preserving clearance around the thicker prompt. Round-cap compensation is recalculated to retain twelve separate dashes and their 22-degree ink / 8-degree gap rhythm.

The glyphs come from the project owner's **Photonico Code Regular** font (internal version 1.4), used with permission and converted to paths. The original font file is not included and is not needed to display the logo. SVG and EPS contain vector paths, with no embedded font or raster image.

These logo assets and the generator are included under the repository's [MIT licence](../LICENSE). The original font file remains subject to its own licence and is not redistributed here.

To regenerate with the original font:

```sh
python -m pip install fonttools cairosvg
python scripts/generate_logo.py /path/to/Photonico-Code-Regular.ttf
```

CairoSVG requires the Cairo graphics library. Regeneration is an optional design step, not an extension runtime dependency.
