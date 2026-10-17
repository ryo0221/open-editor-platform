import type { DeepReadonly, VectorLayer } from '@editor-platform/geo-core';
/** Display policy only: not a CRS transform, measurement accuracy or production capacity contract. */
export const LOCAL_POINT_POLICY = Object.freeze({
  maxSpanDegrees: 5,
  excludedLatitude: 70,
  minimumFrameDegrees: 0.1,
});
export interface PointScene {
  readonly layerId: string;
  readonly status: 'ready' | 'empty' | 'unsupported';
  readonly reasons: readonly string[];
  readonly omitted: readonly { featureId: string; reason: string }[];
  readonly points: readonly {
    featureId: string;
    longitude: number;
    latitude: number;
    x: number;
    y: number;
  }[];
  readonly extent: readonly [number, number, number, number] | null;
}
/** Caller supplies already validated native data. No sorting, wrap, clipping or ID rewriting. */
export function preparePointScene(layer: DeepReadonly<VectorLayer>): PointScene {
  const candidates: { featureId: string; longitude: number; latitude: number }[] = [];
  const omitted: { featureId: string; reason: string }[] = [];
  for (const feature of layer.features) {
    if (!feature.geometry)
      omitted.push({
        featureId: feature.id,
        reason: 'null geometry — location unknown; retained in inspector',
      });
    else if (feature.geometry.type !== 'Point')
      omitted.push({
        featureId: feature.id,
        reason: `${feature.geometry.type} — Point display only; retained in inspector`,
      });
    else
      candidates.push({
        featureId: feature.id,
        longitude: feature.geometry.coordinates[0],
        latitude: feature.geometry.coordinates[1],
      });
  }
  if (!candidates.length)
    return {
      layerId: layer.id,
      status: 'empty',
      reasons: ['No Point geometry to display.'],
      omitted,
      points: [],
      extent: null,
    };
  let west = 180,
    east = -180,
    south = 90,
    north = -90;
  for (const p of candidates) {
    west = Math.min(west, p.longitude);
    east = Math.max(east, p.longitude);
    south = Math.min(south, p.latitude);
    north = Math.max(north, p.latitude);
  }
  const reasons: string[] = [];
  if (east - west > 180)
    reasons.push('Dateline/wide longitude span unsupported — no wrapping or conversion.');
  if (Math.max(Math.abs(south), Math.abs(north)) >= LOCAL_POINT_POLICY.excludedLatitude)
    reasons.push('Polar/high latitude unsupported (absolute latitude >= 70°).');
  if (
    east - west > LOCAL_POINT_POLICY.maxSpanDegrees ||
    north - south > LOCAL_POINT_POLICY.maxSpanDegrees
  )
    reasons.push('Local frame exceeded (longitude or latitude span > 5°).');
  const extent = [west, south, east, north] as const;
  if (reasons.length)
    return { layerId: layer.id, status: 'unsupported', reasons, omitted, points: [], extent };
  // Equal degree scale, north up; fixed SVG frame. Padding never changes native coordinates.
  const scale = Math.min(
    560 / Math.max(east - west, LOCAL_POINT_POLICY.minimumFrameDegrees),
    240 / Math.max(north - south, LOCAL_POINT_POLICY.minimumFrameDegrees),
  );
  const midLon = (west + east) / 2,
    midLat = (south + north) / 2;
  return {
    layerId: layer.id,
    status: 'ready',
    reasons: [],
    omitted,
    extent,
    points: candidates.map((p) => ({
      ...p,
      x: 320 + (p.longitude - midLon) * scale,
      y: 160 - (p.latitude - midLat) * scale,
    })),
  };
}

/** Domain-only SVG view. Selection belongs to the containing inspector, never native content. */
export function createPointMap(
  doc: Document,
  scene: PointScene,
  select: (featureId: string) => void,
) {
  const section = doc.createElement('section');
  section.className = 'geo-point-map';
  section.setAttribute('aria-label', `Local point map ${scene.layerId}`);
  const heading = doc.createElement('h4');
  heading.textContent = 'Local point map · read-only';
  section.append(heading);
  const note = doc.createElement('p');
  note.textContent =
    'Longitude → east; latitude ↑ north. Equal-degree illustrative frame, no basemap. Distances, areas and projection accuracy are not guaranteed. Each layer has its own frame.';
  section.append(note);
  const limits = doc.createElement('p');
  limits.textContent =
    'Display policy: spans ≤ 5° per axis, |latitude| < 70°. Points outside this policy block the whole layer map; native data is retained.';
  section.append(limits);
  const count = doc.createElement('p');
  count.textContent = `${scene.points.length} displayed · ${scene.omitted.length} non-Point/null retained${scene.status === 'unsupported' ? ' · Point layer display blocked' : ''}`;
  section.append(count);
  if (scene.extent) {
    const extent = doc.createElement('p');
    extent.textContent = `Native Point extent [west, south, east, north]: ${scene.extent.join(', ')} degrees`;
    section.append(extent);
  }
  const notes = doc.createElement('ul');
  notes.setAttribute('aria-label', `Map diagnostics ${scene.layerId}`);
  for (const text of [
    ...scene.reasons,
    ...scene.omitted.map((v) => `${v.featureId}: ${v.reason}`),
  ]) {
    const li = doc.createElement('li');
    li.textContent = text;
    notes.append(li);
  }
  if (notes.childElementCount) section.append(notes);
  const markers = new Map<string, SVGGElement>();
  const stops: (() => void)[] = [];
  if (scene.status === 'ready') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 640 320');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `Selectable points ${scene.layerId}`);
    const rect = doc.createElementNS(ns, 'rect');
    rect.setAttribute('x', '1');
    rect.setAttribute('y', '1');
    rect.setAttribute('width', '638');
    rect.setAttribute('height', '318');
    rect.setAttribute('fill', '#edf6f9');
    rect.setAttribute('stroke', '#90aebf');
    svg.append(rect);
    for (const point of scene.points) {
      const g = doc.createElementNS(ns, 'g');
      g.setAttribute('transform', `translate(${point.x} ${point.y})`);
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-pressed', 'false');
      g.setAttribute(
        'aria-label',
        `Select point ${point.featureId}; longitude ${point.longitude}; latitude ${point.latitude}`,
      );
      g.dataset.featureId = point.featureId;
      const circle = doc.createElementNS(ns, 'circle');
      circle.setAttribute('r', '10');
      g.append(circle);
      const title = doc.createElementNS(ns, 'title');
      title.textContent = point.featureId;
      g.append(title);
      const click = () => select(point.featureId);
      const key = (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(point.featureId);
        }
      };
      g.addEventListener('click', click);
      g.addEventListener('keydown', key);
      stops.push(() => {
        g.removeEventListener('click', click);
        g.removeEventListener('keydown', key);
      });
      markers.set(point.featureId, g);
      svg.append(g);
    }
    section.append(svg);
    const help = doc.createElement('p');
    help.textContent =
      'Tab to each point; Enter or Space selects its stable ID in the inspector. Coincident points remain separate; use keyboard or the feature list to select them.';
    section.append(help);
  }
  let closed = false;
  return {
    element: section,
    select(featureId: string | null) {
      if (closed) return;
      for (const [id, marker] of markers)
        marker.setAttribute('aria-pressed', String(id === featureId));
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const stop of stops) stop();
      section.remove();
    },
  };
}
