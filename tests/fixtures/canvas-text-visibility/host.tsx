import { createRoot } from 'react-dom/client';
import { DrawingView } from '@editor-platform/canvas-ui';
import { drawingPrimitives, serializeSvg, type Drawing } from '@editor-platform/editor-core';

const text = Array.from({ length: 100 }, (_, i) => `Line ${i} 日本語🙂 italic underline`).join(
  '\n',
);
const drawings: Drawing[] = Array.from({ length: 12 }, (_, i) => ({
  id: `drawing-${i}`,
  kind: i === 10 ? 'table' : i === 11 ? 'shape' : 'text',
  text,
  fill: '#253044',
  bounds: { x: 0, y: 0, width: 208, height: 100 },
  typography: {
    fontSize: i === 6 ? 52 : 18,
    fontFamily: i % 2 ? 'serif' : 'sans-serif',
    lineHeight: i === 5 ? 0.5 : 1.3,
    verticalAlign: (['top', 'middle', 'bottom'] as const)[i % 3],
    align: (['left', 'center', 'right'] as const)[i % 3],
    overflow: i === 7 ? 'fit' : i === 8 ? 'expand' : 'clip',
    bold: i === 1,
    italic: i === 2,
    underline: i === 3,
    strike: i === 4,
    list: i === 9,
    letterSpacing: i === 9 ? 2 : 0,
  },
  ...(i === 4 ? { rotation: 8, flipY: true } : {}),
  ...(i === 10 ? { table: { rows: [[text, text]] } } : {}),
  ...(i === 11 ? { shape: 'ellipse' as const, fill: '#bde3cf' } : {}),
}));
const full = new URLSearchParams(location.search).has('full');
createRoot(document.getElementById('root')!).render(
  <svg width={780} height={690} style={{ background: 'white' }}>
    {drawings.map((drawing, i) => (
      <g
        key={drawing.id}
        transform={`translate(${20 + (i % 3) * 250} ${18 + Math.floor(i / 3) * 170})`}
      >
        {full ? (
          <g
            dangerouslySetInnerHTML={{
              __html: serializeSvg(drawingPrimitives(drawing, `full-${i}`)),
            }}
          />
        ) : (
          <DrawingView drawing={drawing} />
        )}
      </g>
    ))}
  </svg>,
);
