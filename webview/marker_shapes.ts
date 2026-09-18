import type { tab_marker_shape } from '../src/tab_marker';

interface marker_shape_descriptor {
  readonly label: string;
  readonly path: string;
  readonly fill_rule?: 'evenodd';
}

type point = readonly [number, number];

/** Repeat a filled arm around the centre; only the two fixed six-spoke shapes use this. */
function six_spokes(arm: readonly point[]): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = index * Math.PI / 3;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const vertices = arm.map(([x, y]) => {
      const rotated_x = Number((8 + x * cosine - y * sine).toFixed(3));
      const rotated_y = Number((8 + x * sine + y * cosine).toFixed(3));
      return `${rotated_x} ${rotated_y}`;
    });
    return `M${vertices.join(' ')}Z`;
  }).join('');
}

/**
 * Font-independent, monochrome geometry in a 16 × 16 viewBox.
 * Holes are transparent, so every shape works on any theme background.
 * Existing shape paths remain unchanged to preserve saved marker appearance.
 */
export const marker_shape_descriptors: Readonly<Record<tab_marker_shape, marker_shape_descriptor>> = {
  circle: {
    label: 'Circle',
    path: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Z',
  },
  concentric_circle: {
    label: 'Concentric circles',
    path: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Z'
      + 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z'
      + 'M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z'
      + 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
    fill_rule: 'evenodd',
  },
  triangle: {
    label: 'Triangle',
    path: 'M8 1.5 15 14H1Z',
  },
  triangle_down: {
    label: 'Down triangle',
    path: 'M8 14.5 15 2H1Z',
  },
  triangle_left: {
    label: 'Left triangle',
    path: 'M1.5 8 14 1v14Z',
  },
  triangle_right: {
    label: 'Right triangle',
    path: 'M14.5 8 2 15V1Z',
  },
  diamond: {
    label: 'Diamond',
    path: 'm8 1 7 7-7 7-7-7Z',
  },
  square: {
    label: 'Square',
    path: 'M2 2h12v12H2Z',
  },
  hexagon: {
    label: 'Hexagon',
    path: 'M4.5 2h7L15 8l-3.5 6h-7L1 8Z',
  },
  heart: {
    label: 'Heart',
    path: 'M8 14 2.2 8.5C-.2 6.2 1.1 2 4.5 2 6.1 2 7.3 2.9 8 4 8.7 2.9 9.9 2 11.5 2c3.4 0 4.7 4.2 2.3 6.5Z',
  },
  clubs: {
    label: 'Clubs',
    path: 'M8 1.1a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z'
      + 'M4.5 5a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z'
      + 'M11.5 5a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z'
      + 'M6.7 8.5H9.3C8.55 10.4 9.3 13.25 11 14.5H5C6.7 13.25 7.45 10.4 6.7 8.5Z',
  },
  spade: {
    label: 'Spade',
    path: 'M8 1 2.4 6.5C.1 8.8 1.4 12 4.3 12c1.5 0 2.7-.8 3.7-2.1'
      + ' 1 1.3 2.2 2.1 3.7 2.1 2.9 0 4.2-3.2 1.9-5.5Z'
      + 'M9 8H7c.7 3.3-.2 5.2-2 6.5h6C9.2 13.2 8.3 11.3 9 8Z',
  },
  star_circle: {
    label: 'Star in circle',
    path: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Z'
      + 'M8 2.7 9.293 6.22 13.041 6.362 10.092 8.68 11.115 12.288'
      + ' 8 10.2 4.885 12.288 5.908 8.68 2.959 6.362 6.707 6.22Z',
    fill_rule: 'evenodd',
  },
  four_point_star: {
    label: 'Four-point star',
    path: 'M8 1 10 6 15 8 10 10 8 15 6 10 1 8 6 6Z',
  },
  music_note: {
    label: 'Music note',
    path: 'M9 10.25C7.9 9.65 5.5 10.05 4.15 11.25'
      + 'C2.8 12.45 2.75 13.9 4.1 14.45'
      + 'C5.45 15 7.65 14.45 9.05 13.2'
      + 'C9.85 12.45 10.35 11.6 10.35 10.75V4.3'
      + 'C11.65 4.7 12.5 5.45 12.5 6.5'
      + 'C12.5 7.15 12.25 7.7 11.8 8.25L12.75 8.95'
      + 'C13.55 8.1 13.95 7.05 13.95 6.1'
      + 'C13.95 4.45 12.6 3.6 11.6 2.8'
      + 'C10.9 2.25 10.45 1.8 10.35 1H9Z',
  },
  asterisk: {
    label: 'Asterisk',
    path: six_spokes([[-1.1, 0.2], [-1.1, -6.6], [1.1, -6.6], [1.1, 0.2]]),
  },
  reference_mark: {
    label: 'Reference mark',
    path: 'M2.5 1.4 8 6.9 13.5 1.4 14.6 2.5 9.1 8 14.6 13.5'
      + ' 13.5 14.6 8 9.1 2.5 14.6 1.4 13.5 6.9 8 1.4 2.5Z'
      + 'M8 1.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z'
      + 'M8 12.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z'
      + 'M2.5 6.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z'
      + 'M13.5 6.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z',
  },
  flower: {
    label: 'Flower',
    path: 'M5.943 5.168C4.6-.1 11.4-.1 10.057 5.168'
      + 'C14.653 2.263 16.754 8.731 11.329 9.082'
      + 'C15.512 12.555 10.01 16.552 8 11.5'
      + 'C5.99 16.552 .488 12.555 4.671 9.082'
      + 'C-.754 8.731 1.347 2.263 5.943 5.168Z'
      + 'M8 6.65a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Z',
    fill_rule: 'evenodd',
  },
  snowflake: {
    label: 'Snowflake',
    path: six_spokes([
      [-0.65, 0.2], [-0.65, -3.9], [-2.2, -5.45], [-1.4, -6.25],
      [-0.65, -5.5], [-0.65, -7], [0.65, -7], [0.65, -5.5],
      [1.4, -6.25], [2.2, -5.45], [0.65, -3.9], [0.65, 0.2],
    ]),
  },
};
