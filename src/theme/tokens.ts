import type { ThemeMode } from '../types/config';

/**
 * Colour tokens: one name per role, a value per theme. Teenage Engineering orange (#f15a22) is the
 * accent in both themes.
 *
 * The same values are defined as CSS variables (RGB channels) in src/styles/te-theme.css, which is
 * what the Tailwind classes use (`bg-te-ink`, `text-te-muted`, `border-te-rule/40`, ...). This table is
 * for the few places that need a colour value in JS, such as SVG fill attributes. A unit test keeps
 * the two in sync.
 */
export const COLOR_TOKENS = {
  /** Accent: Teenage Engineering orange, the same in both themes. */
  accent: { ting: '#f15a22', fx: '#f15a22' },
  'accent-hover': { ting: '#ff6b35', fx: '#ff6b35' },
  /** Accent 3D edges and pressed accent. */
  'accent-deep': { ting: '#d14612', fx: '#d14612' },
  /** Block outlines that stay black in both themes. */
  edge: { ting: '#141617', fx: '#141617' },

  /** Primary ink: headings, body text, dark fills and themed outlines. */
  ink: { ting: '#00503a', fx: '#141617' },
  /** Darkest ink: 3D edges of dark buttons and toggle tracks. */
  'ink-deep': { ting: '#003828', fx: '#000000' },
  /** Hover state of dark fills. */
  'ink-hover': { ting: '#00664a', fx: '#232628' },
  /** Raised dark control next to a dark field (pack dropdown chevron). */
  'ink-raised': { ting: '#003d2c', fx: '#232628' },
  /** Secondary text: descriptions, counts, small print. */
  muted: { ting: '#5b695e', fx: '#73787a' },

  /** FX card header: green in TING, orange in FX. */
  header: { ting: '#00503a', fx: '#f15a22' },
  /** 3D edge of the FX card header. */
  'header-deep': { ting: '#003828', fx: '#d14612' },

  /** Card faces. */
  surface: { ting: '#f7f5ef', fx: '#ffffff' },
  /** Body of the FX card and MCP panel. */
  canvas: { ting: '#f4f1ea', fx: '#eceeed' },
  /** Bus switcher and modulation strips. */
  strip: { ting: '#e4dac5', fx: '#eceeed' },
  /** Grey module faces (TOOL, pack row, connector body). */
  face: { ting: '#e8e9e4', fx: '#e5e6e6' },
  'face-hover': { ting: '#f0f1ec', fx: '#eeefef' },
  /** 3D button faces. */
  control: { ting: '#ece6d9', fx: '#e4e5e4' },
  /** Light 3D bevels and the preset name plate. */
  bevel: { ting: '#dbd0b9', fx: '#d8dad9' },
  /** Inset fields: code/URL boxes. */
  field: { ting: '#ece6d9', fx: '#f8f9f8' },
  /** Hairline dividers inside cards and menus. */
  rule: { ting: '#d8ceba', fx: '#e2e4e2' },
  /** Dashed placeholders and light borders. */
  line: { ting: '#b2aca1', fx: '#d2d5d2' },
  /** Disabled controls. */
  'line-strong': { ting: '#cdc3ae', fx: '#c5c8c5' },
  /** Page background behind the blocks. */
  page: { ting: '#dbd0b9', fx: '#abb5ba' }
} as const;

export type ColorToken = keyof typeof COLOR_TOKENS;

/** A token's hex value for a theme (or for `isTing`). */
export function themeColor(token: ColorToken, theme: ThemeMode | boolean): string {
  const isTing = typeof theme === 'boolean' ? theme : theme === 'ting';
  return COLOR_TOKENS[token][isTing ? 'ting' : 'fx'];
}
