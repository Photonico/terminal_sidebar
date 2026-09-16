# Terminal Sidebar logo

- `logo.svg`: 512 × 512 vector master, transparent background, outlined glyphs.
- `logo.eps`: 384 × 384 pt vector EPS export, with the same proportions and margins as the SVG. The background and frame interior are unpainted; EPS does not store an alpha channel.
- `logo.png`: 512 × 512 RGBA export for previews and future extension packaging.

The white circular frame and tightly spaced white `>_` glyphs use matching `#646464` outlines, each 6 units wide on the 512-unit canvas. The glyphs come from the project owner's **Photonico Code Regular** font (internal version 1.4), used with permission and converted to paths. The original font file is not included and is not needed to display the logo.

These logo assets and the generator are included under the repository's [MIT License](../LICENSE). This does not redistribute or change the license of the original font file.

To regenerate with the original font:

```sh
python -m pip install fonttools cairosvg
python scripts/generate_logo.py /path/to/Photonico-Code-Regular.ttf
```

CairoSVG requires the Cairo graphics library. Regeneration is an optional design step, not an extension runtime dependency.
