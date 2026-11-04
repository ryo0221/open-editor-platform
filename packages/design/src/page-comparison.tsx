import { descendantIds } from '@editor-platform/editor-core';
import { DrawingView } from '@editor-platform/canvas-ui';
import { designDrawingProjector, designPaintOrder, type DesignContent } from './model';

/** Two independent native pages. This view never changes membership or capture order. */
export function DesignPageComparison({
  content,
  leftId,
  rightId,
  label,
}: {
  content: DesignContent;
  leftId: string;
  rightId: string;
  label: string;
}) {
  const project = designDrawingProjector(content);
  const order = designPaintOrder(content);
  return (
    <section aria-label={label} className="ep-page-comparison">
      <h3>{label}</h3>
      <div className="ep-page-pair">
        {[leftId, rightId].map((id, side) => {
          const page = content.pagination?.pages.find((p) => p.frameId === id);
          const frame = content.elements.find((e) => e.id === id);
          if (!page || !frame)
            return <div key={side} className="manga-blank-page" aria-label="空きページ" />;
          const included = descendantIds(content.elements, [id]);
          const { x, y, width, height } = frame.bounds;
          return (
            <figure key={side}>
              <svg
                role="img"
                aria-label={`${label}, ${side ? 'right' : 'left'} page`}
                viewBox={`${x} ${y} ${width} ${height}`}
                style={{ aspectRatio: `${width}/${height}` }}
              >
                {order
                  .filter((e) => included.has(e.id) && !e.hidden)
                  .flatMap(project)
                  .map((drawing, i) => (
                    <DrawingView key={`${drawing.id}-${i}`} drawing={drawing} />
                  ))}
              </svg>
              <figcaption>
                Page {content.pagination!.pages.indexOf(page) + 1} · {frame.name}
              </figcaption>
              <ol aria-label={`${label}, ${side ? 'right' : 'left'} panel order`}>
                {page.panelIds.map((panelId) => (
                  <li key={panelId} title={panelId}>
                    {content.elements.find((e) => e.id === panelId)?.name}
                  </li>
                ))}
              </ol>
            </figure>
          );
        })}
      </div>
    </section>
  );
}
