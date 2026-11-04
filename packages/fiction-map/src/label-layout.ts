import type { FictionMapContent } from './model';
import { geometryPoints, paintOrder, stagePoint } from './surface-projection';

export interface LabelOffset {
  x: number;
  y: number;
}
/** Bounded (native <=200 features), deterministic display-only placement in CSS pixels.
 * Conservative boxes avoid label/label overlap; this is not geographic placement or text shaping.
 * Selected labels get priority. A label without a free candidate is omitted; the feature list remains.
 */
export function layoutMapLabels(
  content: FictionMapContent,
  zoom: number,
  visibility: ReadonlyMap<string, boolean>,
  selected: readonly string[],
): Map<string, LabelOffset | null> {
  const result = new Map<string, LabelOffset | null>();
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  const features = paintOrder(content).filter(
    (f) =>
      f.style?.label !== false &&
      (visibility.get(f.layerId) ??
        content.layers.find((l) => l.id === f.layerId)!.visibleByDefault),
  );
  // Stable sort retains layer/native ordering among equally prioritized labels.
  features.sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)));
  for (const f of features) {
    const anchor = stagePoint(geometryPoints(f.geometry)[0], content.coordinateSpace.yAxis);
    const width = [...f.name].length * 14 + 6;
    const candidates = [
      { x: 12, y: -12 },
      { x: 12, y: 24 },
      { x: -width - 12, y: -12 },
      { x: -width - 12, y: 24 },
      { x: 12, y: -36 },
      { x: 12, y: 48 },
      { x: -width - 12, y: -36 },
      { x: -width - 12, y: 48 },
    ];
    let placed: LabelOffset | null = null;
    for (const offset of candidates) {
      const box = {
        x: anchor.x * zoom + offset.x - 3,
        y: anchor.y * zoom + offset.y - 15,
        width,
        height: 21,
      };
      if (
        boxes.some(
          (b) =>
            box.x < b.x + b.width &&
            box.x + box.width > b.x &&
            box.y < b.y + b.height &&
            box.y + box.height > b.y,
        )
      )
        continue;
      boxes.push(box);
      placed = offset;
      break;
    }
    result.set(f.id, placed);
  }
  return result;
}
