import type { tab_marker_shape } from '../src/tab_marker';

interface marker_shape_descriptor {
  readonly label: string;
  readonly glyph: string;
}

/**
 * Render the selected characters using the terminal's configured font.
 * Text presentation keeps the sideways triangles monochrome instead of emoji.
 */
export const marker_shape_descriptors: Readonly<Record<tab_marker_shape, marker_shape_descriptor>> = {
  circle: {
    label: 'Circle',
    glyph: '●',
  },
  triangle: {
    label: 'Triangle',
    glyph: '▲',
  },
  triangle_right: {
    label: 'Right triangle',
    glyph: '▶\uFE0E',
  },
  triangle_down: {
    label: 'Down triangle',
    glyph: '▼',
  },
  triangle_left: {
    label: 'Left triangle',
    glyph: '◀\uFE0E',
  },
  diamond: {
    label: 'Diamond',
    glyph: '◆',
  },
  square: {
    label: 'Square',
    glyph: '■',
  },
  pentagon_right: {
    label: 'Right-pointing pentagon',
    glyph: '⭓',
  },
  hexagon: {
    label: 'Hexagon',
    glyph: '⬢',
  },
};
