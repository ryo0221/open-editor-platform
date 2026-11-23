import { DrawingView } from '@editor-platform/canvas-ui';
import {
  liveReferenceText,
  useLiveFigure,
  type LiveReferenceConnection,
} from '@editor-platform/artifact-references/react';
import { slideDrawing, type SlideObject } from './model';
import { projectedReference, type SlideEditing } from './view-shared';

/** One object as drawn in thumbnails and the presentation, including fixed citations. */
export function SlideObjectDrawing({
  object,
  editing,
}: {
  object: SlideObject;
  editing: SlideEditing;
}) {
  return object.liveQuote ? (
    <SlideLiveDrawing
      object={{ ...object, liveQuote: object.liveQuote }}
      connection={editing.liveReferences}
      copy
    />
  ) : (
    <DrawingView drawing={slideDrawing(projectedReference(object, editing.references))} />
  );
}

export function SlideLiveDrawing({
  object,
  connection,
  newer,
  copy,
}: {
  object: SlideObject & { liveQuote: NonNullable<SlideObject['liveQuote']> };
  connection?: LiveReferenceConnection;
  newer?: boolean;
  /** A thumbnail or presentation copy: drawn the same, but not the editable quote. */
  copy?: boolean;
}) {
  const {
    bounds: { x, y, width, height },
    liveQuote: reference,
  } = object;
  const figure = reference.presentation.kind === 'figure';
  const projection = useLiveFigure(
    reference,
    connection?.provider,
    connection?.destinationArtifactId,
  );
  const label = liveReferenceText(reference);
  return (
    <g
      className={copy ? 'ep-slide-live-quote-copy' : 'ep-slide-live-quote'}
      aria-label={copy ? undefined : `引用 ${label}`}
    >
      {figure ? (
        <DrawingView drawing={{ ...slideDrawing(object), src: projection?.src, alt: label }} />
      ) : (
        <>
          <rect x={x} y={y} width={width} height={height} rx={4} fill="#e4f3ea" />
          <DrawingView drawing={{ ...slideDrawing(object), text: `引用 ${label}` }} />
          <line
            x1={x + 4}
            x2={x + width - 4}
            y1={y + height - 3}
            y2={y + height - 3}
            stroke="#174d37"
          />
        </>
      )}
      {figure && !projection?.src && (
        <text x={x + 5} y={y + 20} fill="#174d37">
          {label}
        </text>
      )}
      {projection?.error && <title>{projection.error}</title>}
      {newer && (
        <text
          x={x + 4}
          y={y >= 16 ? y - 15 : y}
          dominantBaseline="hanging"
          fontSize="14"
          fill="#174d37"
          stroke="#e4f3ea"
          strokeWidth="3"
          paintOrder="stroke"
        >
          新しい版があります
        </text>
      )}
    </g>
  );
}
