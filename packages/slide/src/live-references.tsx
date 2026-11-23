import { DrawingView } from '@editor-platform/canvas-ui';
import {
  liveReferenceText,
  useLiveFigure,
  type LiveReferenceConnection,
} from '@editor-platform/artifact-references/react';
import type { LiveReference } from '@editor-platform/artifact-references';
import { slideDrawing, slideLiveReference, type SlideObject } from './model';
import { projectedReference, type SlideEditing } from './view-shared';

/** One object as drawn in thumbnails and the presentation, including fixed citations. */
export function SlideObjectDrawing({
  object,
  editing,
}: {
  object: SlideObject;
  editing: SlideEditing;
}) {
  if (object.hidden) return null;
  return object.liveQuote ? (
    <SlideLiveDrawing
      object={{ ...object, liveQuote: slideLiveReference(editing.content, object.liveQuote) }}
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
  /** The citation with its version (`slideLiveReference`). */
  object: SlideObject & { liveQuote: LiveReference };
  connection?: LiveReferenceConnection;
  newer?: boolean;
  /** A thumbnail or presentation copy draws the captured value or figure. */
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
  if (copy) {
    const reason = figure
      ? (projection?.error ?? (!connection?.provider ? '固定版の図を取得できません。' : undefined))
      : undefined;
    return (
      <g className="ep-slide-live-quote-copy">
        {reason && <title>{`${label} · ${reason}`}</title>}
        <DrawingView
          drawing={
            figure && !projection?.src
              ? {
                  ...slideDrawing(object),
                  kind: 'text',
                  text: reason ? `${label}\n${reason}` : label,
                  runs: undefined,
                  typography: { fontSize: 18 },
                }
              : figure
                ? { ...slideDrawing(object), src: projection?.src, alt: label }
                : slideDrawing(object)
          }
        />
      </g>
    );
  }
  return (
    <g className="ep-slide-live-quote" aria-label={`引用 ${label}`}>
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
