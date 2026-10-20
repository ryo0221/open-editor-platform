import { layoutTextRuns } from '@editor-platform/editor-core';
import type { Layer2, VectorPath2 } from './model';

export const animationSvgAttribute2 = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
export const animationSvgPathData2 = (path: VectorPath2) =>
  path.map((command) => command.join(' ')).join(' ');

/** Pure serialized text projection shared by admission, evaluation and SVG output. */
export function animationSvgTextData2(layer: Extract<Layer2, { type: 'text' }>) {
  let y = 0;
  return layoutTextRuns(layer.text, layer.runs, layer.width, {
    fontSize: layer.fontSize,
    lineHeight: layer.lineHeight,
    color: layer.fill,
  })
    .map((line) => {
      const baseline = y + line.ascent;
      y += line.height;
      return `<tspan x="0" y="${baseline}">${line.runs
        .map((run) => {
          const style = run.style ?? {},
            decorations = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
              .filter(Boolean)
              .join(' ');
          return `<tspan fill="${style.color ?? layer.fill}" font-size="${style.fontSize ?? layer.fontSize}" font-weight="${style.bold ? 700 : 400}" font-style="${style.italic ? 'italic' : 'normal'}" text-decoration="${decorations || 'none'}">${animationSvgAttribute2(run.text)}</tspan>`;
        })
        .join('')}</tspan>`;
    })
    .join('');
}
