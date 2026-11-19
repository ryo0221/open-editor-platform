/** CLF10: how wide a sketch note's text is drawn in Sketch mode (`.cad-sketch-note`, measured at 100 px). */
const noteFont = '100px system-ui, sans-serif';
let noteMeasure: CanvasRenderingContext2D | null | undefined;
/**
 * A note's text width in em: measured in its drawing font, or without a canvas (tests) 1 em for a
 * wide (CJK, full-width) glyph and 0.6 em for any other.
 */
export function noteEms(text: string) {
  if (noteMeasure === undefined)
    try {
      noteMeasure = document.createElement('canvas').getContext('2d');
    } catch {
      noteMeasure = null;
    }
  if (noteMeasure) {
    noteMeasure.font = noteFont;
    const w = noteMeasure.measureText(text).width;
    if (w > 0) return w / 100;
  }
  return [...text].reduce(
    (sum, ch) =>
      sum +
      (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u.test(
        ch,
      )
        ? 1
        : 0.6),
    0,
  );
}
