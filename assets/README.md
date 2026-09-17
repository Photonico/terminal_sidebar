# Terminal Sidebar logo

- `logo.svg`: 512 × 512 vector master, transparent background, outlined glyphs.
- `logo.eps`: 384 × 384 pt vector EPS export, with the same proportions and margins as the SVG. The background and frame interior are unpainted; EPS does not store an alpha channel.
- `logo.png`: 512 × 512 RGBA export for extension packaging and previews.

The circular frame consists of twelve white dashes with rounded ends. Each dash occupies 20 degrees of visible ink, followed by a 10-degree transparent gap, measured along the circle's 194-unit centreline radius. The resulting solid-to-gap ratio is 2:1. The generator compensates for the round caps, including their grey outline; a simple 2:1 dash array would produce longer visible dashes and smaller gaps.

The frame and compact `>_` prompt have a nominal body width of 28 units and a centred `#646464` outline 6 units wide. The visible white band is therefore 22 units wide, and the complete outlined stroke is 34 units wide. The prompt retains the original font contours and spacing. Two layered strokes increase its original 19.18-unit underscore body to match the frame without stretching the glyphs.

The glyphs come from the project owner's **Photonico Code Regular** font (internal version 1.4), used with permission and converted to paths. The original font file is not included and is not needed to display the logo. SVG and EPS contain vector paths, with no embedded font or raster image.

These logo assets and the generator are included under the repository's [MIT licence](../LICENSE). The original font file remains subject to its own licence and is not redistributed here.

To regenerate with the original font:

```sh
python -m pip install fonttools cairosvg
python scripts/generate_logo.py /path/to/Photonico-Code-Regular.ttf
```

CairoSVG requires the Cairo graphics library. Regeneration is an optional design step, not an extension runtime dependency.
