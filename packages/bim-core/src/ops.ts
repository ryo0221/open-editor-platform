import type {
  GeometryGraph,
  GeometryLoop,
  GeometryOp,
  GeometryVec3,
} from '@editor-platform/geometry-core';
import { BimContext, deriveBim, loopExtreme, type BimDerived, type BimShape } from './derive';
import { left } from './geometry';
import type { BimDocument, BimLoop, BimType, BimWall, Vec2 } from './model';
import {
  bimProfileLoops,
  bimRoofPlanes,
  bimWallAxis,
  bimWallOpeningLoop,
  profileHeight,
} from './solids';

/**
 * The kernel recipe of a building (docs/cad/r2c-architecture.md, 評価と規模): each element's solid
 * as nodes of one op graph (`geometry-core`), from the derived shapes, the same solids the IFC
 * export writes. Pure; the evaluator keys each solid by `geometryNodeKey`, so equal recipes
 * (columns, beams, doors and windows of one type and size) are built once.
 */

/** A rigid placement of a shared solid: row-major rotation, then translation. */
export interface BimPlacement {
  rotation: number[];
  translation: GeometryVec3;
}

export interface BimElementGeometry {
  /** The element's solid: in place, or at the origin when `placement` is given. */
  node: string;
  /** Where the shared solid goes. Absent: the node is already in place. */
  placement?: BimPlacement;
  /** A wall's solid before its openings, measured for its gross volume when the kernel must. */
  gross?: string;
}

export interface BimGeometry {
  graph: GeometryGraph;
  /** By element ID. Elements that are voids (openings) or failed to derive have none. */
  elements: Map<string, BimElementGeometry>;
  /** The BRep assets the graph reads: a part type's referenced version, by its content hash. */
  assets: Map<string, { typeId: string }>;
}

/**
 * Node IDs: the element's ID, a NUL (which no element ID holds) and the node's role in the
 * element (`solid`, `opening:<id>`, `clip0`, …), so no two elements' nodes can meet. The
 * evaluator keys solids by content, not by these.
 */
const idOf = (elementId: string, role: string) => `${elementId}\u0000${role}`;
/** The role of a node in its element (see `idOf`). */
export const bimNodeRole = (node: string) => node.slice(node.indexOf('\u0000') + 1);

const up: GeometryVec3 = [0, 0, 1];
const flat = (z: number) => ({
  origin: [0, 0, z] as GeometryVec3,
  x: [1, 0, 0] as GeometryVec3,
  z: up,
});
const loop = (l: BimLoop | Vec2[]): GeometryLoop => l.map((v) => [...v] as GeometryLoop[number]);
/** A turn about +z by `angle`, row-major. */
const turn = (angle: number) => {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

export function bimGeometry(doc: BimDocument, derived: BimDerived = deriveBim(doc)): BimGeometry {
  const ctx = new BimContext(doc);
  const nodes: Record<string, GeometryOp> = {};
  const elements = new Map<string, BimElementGeometry>();
  const assets = new Map<string, { typeId: string }>();
  const shapeOf = <K extends BimShape['kind']>(id: string) =>
    derived.shapes.get(id) as Extract<BimShape, { kind: K }> | undefined;

  /** Cuts what lies above a roof's underside, one half-space per plane of it. */
  const clip = (input: string, roofId: string, id: string) => {
    const roof = shapeOf<'roof'>(roofId);
    if (!roof) return undefined;
    return roof.faces.reduce((acc, f, i) => {
      const { under } = bimRoofPlanes(roof, f);
      const node = idOf(id, `clip${i}`);
      nodes[node] = {
        op: 'halfSpace',
        input: acc,
        origin: under.p,
        normal: under.n,
        keep: 'below',
      };
      return node;
    }, input);
  };

  for (const e of doc.elements) {
    const s = derived.shapes.get(e.id);
    if (!s || s.kind === 'void') continue;
    switch (s.kind) {
      case 'wall': {
        const prism = idOf(e.id, 'prism');
        nodes[prism] = {
          op: 'prism',
          frame: flat(s.zBase),
          outer: loop(s.footprint),
          vector: [0, 0, s.zTop - s.zBase],
        };
        const gross = s.clipBy ? clip(prism, s.clipBy, e.id) : prism;
        if (!gross) continue; // the roof failed and is reported
        const tools = s.openings.map((o) => {
          const node = idOf(e.id, `opening:${o.elementId}`);
          nodes[node] = {
            op: 'prism',
            frame: flat(s.zBase + o.sillMm),
            outer: loop(bimWallOpeningLoop(ctx, e as BimWall, o.alongMm, o.widthMm)),
            vector: [0, 0, o.heightMm],
          };
          return node;
        });
        if (tools.length)
          nodes[idOf(e.id, 'solid')] = { op: 'boolean', kind: 'cut', target: gross, tools };
        elements.set(e.id, {
          node: tools.length ? idOf(e.id, 'solid') : gross,
          ...(s.clipBy ? { gross } : {}),
        });
        break;
      }
      case 'slab':
        nodes[idOf(e.id, 'solid')] = {
          op: 'prism',
          frame: flat(s.zBottom),
          outer: loop(s.boundary),
          ...(s.holes.length ? { holes: s.holes.map(loop) } : {}),
          vector: [0, 0, s.zTop - s.zBottom],
        };
        elements.set(e.id, { node: idOf(e.id, 'solid') });
        break;
      case 'space':
        nodes[idOf(e.id, 'solid')] = {
          op: 'prism',
          frame: flat(s.zBase),
          outer: loop(s.boundary),
          vector: [0, 0, s.zTop - s.zBase],
        };
        elements.set(e.id, { node: idOf(e.id, 'solid') });
        break;
      case 'roof': {
        if (s.faces[0]!.slope === 0) {
          nodes[idOf(e.id, 'solid')] = {
            op: 'prism',
            frame: flat(s.zBase),
            outer: loop(s.boundary),
            vector: [0, 0, s.thicknessMm],
          };
          elements.set(e.id, { node: idOf(e.id, 'solid') });
          break;
        }
        // Each plane over its part of the plan: a prism cut above by its top and below by its
        // underside (as the IFC export writes it), the parts joined.
        const parts = s.faces.map((f, i) => {
          const { under, top } = bimRoofPlanes(s, f);
          const area = f.region ?? s.boundary;
          // How far the part reaches up the slope, exact on arcs.
          const highest = loopExtreme(area, [-f.direction[0], -f.direction[1]]);
          const reach =
            (highest[0] - f.origin[0]) * f.direction[0] +
            (highest[1] - f.origin[1]) * f.direction[1];
          const height = f.slope * reach + s.thicknessMm * Math.sqrt(1 + f.slope ** 2) + 10;
          const prism = idOf(e.id, `part${i}`);
          nodes[prism] = {
            op: 'prism',
            frame: flat(s.zBase - 10),
            outer: loop(area),
            vector: [0, 0, height + 10],
          };
          const below = idOf(e.id, `part${i}:top`);
          nodes[below] = {
            op: 'halfSpace',
            input: prism,
            origin: top.p,
            normal: top.n,
            keep: 'below',
          };
          const node = s.faces.length === 1 ? idOf(e.id, 'solid') : idOf(e.id, `part${i}:under`);
          nodes[node] = {
            op: 'halfSpace',
            input: below,
            origin: under.p,
            normal: under.n,
            keep: 'above',
          };
          return node;
        });
        if (parts.length > 1)
          nodes[idOf(e.id, 'solid')] = {
            op: 'boolean',
            kind: 'union',
            target: parts[0]!,
            tools: parts.slice(1),
          };
        elements.set(e.id, { node: idOf(e.id, 'solid') });
        break;
      }
      case 'column': {
        const { outer, holes } = bimProfileLoops(s.profile);
        // One solid per profile and height, turned and moved into place.
        const base = idOf(e.id, 'base');
        nodes[base] = {
          op: 'prism',
          frame: flat(0),
          outer: loop(outer),
          ...(holes.length ? { holes: holes.map(loop) } : {}),
          vector: [0, 0, s.zTop - s.zBase],
        };
        const placement: BimPlacement = {
          rotation: turn(s.rotationRad),
          translation: [s.at[0], s.at[1], s.zBase],
        };
        if (!s.clipBy) {
          elements.set(e.id, { node: base, placement });
          break;
        }
        const placed = idOf(e.id, 'placed');
        nodes[placed] = { op: 'transform', input: base, ...placement };
        const clipped = clip(placed, s.clipBy, e.id);
        if (!clipped) continue;
        elements.set(e.id, { node: clipped });
        break;
      }
      case 'beam': {
        const { outer, holes } = bimProfileLoops(s.profile);
        const d: Vec2 = [s.end[0] - s.start[0], s.end[1] - s.start[1]];
        const len = Math.hypot(...d);
        const u: Vec2 = [d[0] / len, d[1] / len];
        const n = left(u);
        // The profile across the beam (x to the left, y up), swept along it from its start.
        const base = idOf(e.id, 'base');
        nodes[base] = {
          op: 'prism',
          frame: flat(0),
          outer: loop(outer),
          ...(holes.length ? { holes: holes.map(loop) } : {}),
          vector: [0, 0, len],
        };
        elements.set(e.id, {
          node: base,
          placement: {
            rotation: [n[0], 0, u[0], n[1], 0, u[1], 0, 1, 0],
            translation: [s.start[0], s.start[1], s.zTop - profileHeight(s.profile) / 2],
          },
        });
        break;
      }
      case 'part': {
        const t = ctx.types.get((e as { typeId: string }).typeId) as Extract<
          BimType,
          { kind: 'part' }
        >;
        const asset = t.source.contentHash;
        assets.set(asset, { typeId: t.id });
        const base = idOf(e.id, 'base');
        nodes[base] = { op: 'brep', asset };
        elements.set(e.id, {
          node: base,
          placement: { rotation: turn(s.rotationRad), translation: [s.at[0], s.at[1], s.zBase] },
        });
        break;
      }
    }
  }

  // Doors and windows: a panel shared by the type and size, standing on the host's axis.

  for (const e of doc.elements) {
    if (e.kind !== 'door' && e.kind !== 'window') continue;
    const host = ctx.elements.get(e.hostId) as BimWall | undefined;
    const hs = shapeOf<'wall'>(e.hostId);
    if (!host || !hs || derived.shapes.get(e.id)?.kind !== 'void') continue;
    const t = ctx.types.get(e.typeId) as Extract<BimType, { kind: 'door' | 'window' }>;
    const a = bimWallAxis(ctx, host);
    const [p, tangent] = a.at(e.alongMm);
    const x: Vec2 = e.flipFacing ? [-tangent[0], -tangent[1]] : tangent;
    const origin: Vec2 = e.flipFacing
      ? [p[0] + tangent[0] * t.widthMm, p[1] + tangent[1] * t.widthMm]
      : p;
    const mid = (a.leftOff + a.rightOff) / 2;
    const nn = left(tangent);
    const base = idOf(e.id, 'base');
    nodes[base] = {
      op: 'prism',
      frame: flat(0),
      outer: [
        [0, -bimPanelMm / 2],
        [t.widthMm, -bimPanelMm / 2],
        [t.widthMm, bimPanelMm / 2],
        [0, bimPanelMm / 2],
      ],
      vector: [0, 0, t.heightMm],
    };
    elements.set(e.id, {
      node: base,
      placement: {
        rotation: turn(Math.atan2(x[1], x[0])),
        translation: [
          origin[0] + nn[0] * mid,
          origin[1] + nn[1] * mid,
          hs.zBase + (e.kind === 'window' ? e.sillMm : 0),
        ],
      },
    });
  }
  return { graph: { nodes }, elements, assets };
}

/** Thickness of a door's or window's panel, as the IFC export writes it. */
export const bimPanelMm = 50;
