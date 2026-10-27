// Generated from theme/tokens.json by theme/build.mjs — do not edit; change tokens.json and run `node theme/build.mjs`.

/** The viewer colours, in order (the first is the Default viewer's). */
export const VIEWER_COLORS = ["#5b8def","#e5484d","#30a46c","#f5a524","#8e4ec6","#12a594","#e93d82","#978365"]

// Each viewer colour's initials colour.
const INITIALS = {"#5b8def":"#ffffff","#e5484d":"#ffffff","#30a46c":"#ffffff","#f5a524":"#141417","#8e4ec6":"#ffffff","#12a594":"#ffffff","#e93d82":"#ffffff","#978365":"#ffffff"}

/** The colour a viewer's initials go in on their avatar colour (white on one not in the list). */
export function viewerInitialsColor(color) {
  return INITIALS[String(color || '').toLowerCase()] ?? '#ffffff'
}
