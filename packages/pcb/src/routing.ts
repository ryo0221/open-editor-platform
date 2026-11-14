import {
  componentPads,
  pcbCopperLayerNames,
  pcbPadNets,
  pointInPolygon,
  sampleLoop,
  type PcbDocument,
  type Vec2,
} from '@editor-platform/pcb-core';

/** The end of `from → to` turned to the nearest multiple of 45°, keeping its reach along it. */
export function constrain45(from: Vec2, to: Vec2): Vec2 {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return to;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const ux = Math.round(Math.cos(a) * 1e12) / 1e12;
  const uy = Math.round(Math.sin(a) * 1e12) / 1e12;
  const len = dx * ux + dy * uy;
  const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
  return [r(from[0] + ux * len), r(from[1] + uy * len)];
}

/** Copper a track may start or end on: a pad, a via or a track end, with its centre and net. */
export interface PcbRouteTarget {
  kind: 'pad' | 'via' | 'track';
  at: Vec2;
  net?: string;
  /** Pad: `ref.pad`; via and track: ID. */
  label: string;
}

/**
 * The copper under `p` that is on `layer` (vias are on every layer), within `slack` mm: vias
 * first, then track ends, then pads (whose centre is returned, so tracks meet pads squarely).
 */
export function pcbRouteTarget(
  doc: PcbDocument,
  p: Vec2,
  layer: string,
  slack: number,
): PcbRouteTarget | undefined {
  const d = (a: Vec2) => Math.hypot(a[0] - p[0], a[1] - p[1]);
  for (const v of [...doc.vias].reverse())
    if (d(v.at) <= v.diameterMm / 2 + slack)
      return { kind: 'via', at: v.at, net: v.net, label: v.id };
  for (const t of [...doc.tracks].reverse()) {
    if (t.layer !== layer) continue;
    for (const end of [t.from, t.to])
      if (d(end) <= t.widthMm / 2 + slack)
        return { kind: 'track', at: end, net: t.net, label: t.id };
  }
  const nets = pcbPadNets(doc);
  const copper = pcbCopperLayerNames(doc.board.copperLayers);
  for (const c of [...doc.components].reverse())
    for (const pad of componentPads(doc, c)) {
      if (!pad.layers.includes(layer) || !copper.includes(layer)) continue;
      if (pointInPolygon(p, sampleLoop(pad.loop)) || d(pad.at) <= slack)
        return {
          kind: 'pad',
          at: pad.at,
          net: nets.get(`${c.id}\u0000${pad.pad.number}`),
          label: `${c.ref}.${pad.pad.number}`,
        };
    }
  return undefined;
}

/** Display colours of copper layers: front red, back blue, inner layers in between. */
export function pcbLayerColor(layer: string): string {
  if (layer === 'F.Cu') return '#d0403a';
  if (layer === 'B.Cu') return '#3f74d8';
  const k = Number(/^In(\d+)\.Cu$/.exec(layer)?.[1] ?? 1);
  return ['#c9a227', '#2fa36b', '#b05cc9', '#d07a2a', '#2aa7b8', '#8a8f2a'][(k - 1) % 6];
}
