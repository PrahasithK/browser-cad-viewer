/**
 * Inline SVG icon set replacing the app's prior raw emoji/unicode glyphs (📁📦◆👁⊘🗑▾▸✕⇄▭○⬡▬
 * ↶↷⛶⟲▱◼▦◻#✛📷◐), for a consistent, theme-aware (currentColor stroke) look across the toolbar,
 * ribbon, model tree, and tool panels. Pure data — a name → SVG-inner-markup map, paired with the
 * `Icon` component that renders one. Kept as a plain util (not a components/ file) since it's
 * static data with no logic, the same convention as other single-purpose utils in this folder.
 */
export type IconName =
  | 'folder'
  | 'package'
  | 'body'
  | 'eye'
  | 'eye-off'
  | 'trash'
  | 'chevron-down'
  | 'chevron-right'
  | 'close'
  | 'flip'
  | 'rectangle'
  | 'circle'
  | 'polygon'
  | 'slot'
  | 'polyline'
  | 'undo'
  | 'redo'
  | 'chevron-down-small'
  | 'fit-all'
  | 'reset-camera'
  | 'projection'
  | 'shading-solid'
  | 'shading-wireframe'
  | 'shading-transparent'
  | 'grid'
  | 'axes'
  | 'camera'
  | 'fullscreen'
  | 'dark-mode'
  | 'search'
  | 'rename'
  | 'duplicate'
  | 'isolate'
  | 'show-all'
  | 'focus'
  | 'properties'
  | 'move'
  | 'rotate'
  | 'scale';

/** SVG inner markup (viewBox 0 0 24 24) per icon name — stroke-based, currentColor, so it inherits button text color/state. */
const ICONS: Record<IconName, string> = {
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z"/>',
  package: '<path d="M21 8 12 3 3 8l9 5 9-5z"/><path d="M3 8v9l9 5 9-5V8"/><path d="M12 13v9"/>',
  body: '<path d="M12 3 4 8v8l8 5 8-5V8z"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="M3 3l18 18"/><path d="M10.6 5.1A11 11 0 0 1 12 5c7 0 11 7 11 7a13.6 13.6 0 0 1-3.1 3.8"/><path d="M6.5 6.6C3.6 8.4 1 12 1 12s4 7 11 7a10.6 10.6 0 0 0 4.2-.9"/><path d="M9.5 9.5a3 3 0 0 0 4.2 4.2"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  flip: '<path d="M7 7h7l-2-2"/><path d="M17 17H10l2 2"/><path d="M7 7v10"/><path d="M17 7v10"/>',
  rectangle: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  polygon: '<path d="M12 3l8 6-3 10H7L4 9z"/>',
  slot: '<rect x="3" y="9" width="18" height="6" rx="3"/>',
  polyline: '<path d="M4 18l5-11 5 7 6-10"/><circle cx="4" cy="18" r="1.4"/><circle cx="9" cy="7" r="1.4"/><circle cx="14" cy="14" r="1.4"/><circle cx="20" cy="4" r="1.4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/>',
  'chevron-down-small': '<path d="M6 9l6 6 6-6"/>',
  'fit-all': '<path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M20 9V5a1 1 0 0 0-1-1h-4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M20 15v4a1 1 0 0 1-1 1h-4"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  'reset-camera': '<path d="M3 12a9 9 0 1 1 3 6.7"/><path d="M3 17v-5h5"/>',
  projection: '<rect x="3" y="7" width="12" height="12" rx="1"/><path d="M9 7 15 3l6 4-6 4"/><path d="M21 7v10l-6 4"/>',
  'shading-solid': '<rect x="4" y="4" width="16" height="16" rx="1"/>',
  'shading-wireframe': '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 10h16"/><path d="M4 16h16"/><path d="M10 4v16"/><path d="M16 4v16"/>',
  'shading-transparent': '<rect x="4" y="4" width="16" height="16" rx="1" fill="none"/>',
  grid: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M9 4v16"/><path d="M15 4v16"/>',
  axes: '<path d="M12 20V4"/><path d="M4 20l8-16"/><path d="M4 20h16"/>',
  camera: '<path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  fullscreen: '<path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M20 9V5a1 1 0 0 0-1-1h-4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M20 15v4a1 1 0 0 1-1 1h-4"/>',
  'dark-mode': '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="M20 20l-5.5-5.5"/>',
  rename: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  duplicate: '<rect x="9" y="9" width="12" height="12" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  isolate: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/>',
  'show-all': '<circle cx="8" cy="8" r="4"/><circle cx="16" cy="16" r="4"/>',
  focus: '<path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M20 9V5a1 1 0 0 0-1-1h-4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M20 15v4a1 1 0 0 1-1 1h-4"/><circle cx="12" cy="12" r="2.5"/>',
  properties: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h7"/><circle cx="19" cy="12" r="2"/>',
  move: '<path d="M12 2v20"/><path d="M2 12h20"/><path d="M12 2 9 5"/><path d="M12 2l3 3"/><path d="M12 22l-3-3"/><path d="M12 22l3-3"/><path d="M2 12l3-3"/><path d="M2 12l3 3"/><path d="M22 12l-3-3"/><path d="M22 12l-3 3"/>',
  rotate: '<path d="M4 12a8 8 0 0 1 14.5-4.5"/><path d="M20 12a8 8 0 0 1-14.5 4.5"/><path d="M18.5 3v4.5H14"/><path d="M5.5 21v-4.5H10"/>',
  scale: '<path d="M9 3H3v6"/><path d="M15 21h6v-6"/><path d="M21 3l-8 8"/><path d="M3 21l8-8"/>'
};

/** Returns the inner SVG markup for a given icon name, or an empty string if unregistered (fails visibly-empty rather than throwing, since icons are cosmetic). */
export function getIconMarkup(name: IconName): string {
  return ICONS[name] ?? '';
}
