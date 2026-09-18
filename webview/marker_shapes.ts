import type { tab_marker_shape } from '../src/tab_marker';

interface marker_shape_descriptor {
  readonly label: string;
  readonly path: string;
}

/**
 * Font-independent, monochrome geometry in a shared 16 × 16 viewBox.
 * Filled areas are approximately 100 square units: pointed shapes extend farther
 * than circles and squares so they retain comparable visual weight at 14 px.
 */
export const marker_shape_descriptors: Readonly<Record<tab_marker_shape, marker_shape_descriptor>> = {
  circle: {
    label: 'Circle',
    path: 'M8 2.35a5.65 5.65 0 1 0 0 11.3 5.65 5.65 0 0 0 0-11.3Z',
  },
  triangle: {
    label: 'Triangle',
    path: 'M8 .95 15.05 15.05H.95Z',
  },
  triangle_right: {
    label: 'Right triangle',
    path: 'M15.05 8 .95 15.05V.95Z',
  },
  triangle_down: {
    label: 'Down triangle',
    path: 'M8 15.05 .95 .95h14.1Z',
  },
  triangle_left: {
    label: 'Left triangle',
    path: 'M.95 8 15.05 .95v14.1Z',
  },
  diamond: {
    label: 'Diamond',
    path: 'M8 1 15 8 8 15 1 8Z',
  },
  square: {
    label: 'Square',
    path: 'M3 3h10v10H3Z',
  },
  pentagon_right: {
    label: 'Right-pointing pentagon',
    path: 'M14.5 8 10.009 14.182 2.741 11.821 2.741 4.179 10.009 1.818Z',
  },
  hexagon: {
    label: 'Hexagon',
    path: 'M4.9 2.631h6.2L14.2 8l-3.1 5.369H4.9L1.8 8Z',
  },
};
