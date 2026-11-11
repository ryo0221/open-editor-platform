import type {
  GeometryGraph,
  GeometryLoop,
  GeometryOp,
  GeometryVec3,
} from '@editor-platform/geometry-core';
import { BimContext, deriveBim, loopExtreme, type BimDerived, type BimShape } from './derive';
import { left } from './geometry';
import type { BimDocument, BimLoop, BimType, BimWall, Vec2 } from './model';
import { bimLimits } from './model';
import {
  bimProfileLoops,
  bimSectionAxes,
  type BimSectionAxes,
  bimRoofPlanes,
  bimSlabPlanes,
  bimWallAxis,
  bimWallOpeningLoop,
  bimWallOpeningRise,
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
/** LR3: the angle between a spiral ramp's sections (5°). */
export const bimRampStepRad = Math.PI / 36;
/** TW2: a section's turn onto its axes, row-major: the columns are x, y and z. */
const axesTurn = ({ x, y, z }: Pick<BimSectionAxes, 'x' | 'y' | 'z'>) => [
  x[0],
  y[0],
  z[0],
  x[1],
  y[1],
  z[1],
  x[2],
  y[2],
  z[2],
];
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
        // LR2: a leaning wall is ruled between its base and top footprints.
        nodes[prism] = s.footprintTop
          ? {
              op: 'loft',
              sections: [
                { frame: flat(s.zBase), outer: loop(s.footprint) },
                { frame: flat(s.zTop), outer: loop(s.footprintTop) },
              ],
            }
          : {
              op: 'prism',
              frame: flat(s.zBase),
              outer: loop(s.footprint),
              vector: [0, 0, s.zTop - s.zBase],
            };
        const gross = s.clipBy ? clip(prism, s.clipBy, e.id) : prism;
        if (!gross) continue; // the roof failed and is reported
        const wall = e as BimWall;
        const tools = s.openings.map((o) => {
          const node = idOf(e.id, `opening:${o.elementId}`);
          // FU3a: through a leaning wall, ruled between the plan regions at its sill and head.
          const [z0, z1] = bimWallOpeningRise(wall, o.sillMm, o.heightMm);
          const at = (rise: number) =>
            loop(bimWallOpeningLoop(ctx, wall, o.alongMm, o.widthMm, rise));
          // LS2: an upright wall ruled for its joins cuts its openings upright.
          nodes[node] = wall.lean
            ? {
                op: 'loft',
                sections: [
                  { frame: flat(s.zBase + z0), outer: at(z0) },
                  { frame: flat(s.zBase + z1), outer: at(z1) },
                ],
              }
            : {
                op: 'prism',
                frame: flat(s.zBase + o.sillMm),
                outer: at(0),
                vector: [0, 0, o.heightMm],
              };
          return node;
        });
        if (tools.length)
          nodes[idOf(e.id, 'solid')] = { op: 'boolean', kind: 'cut', target: gross, tools };
        // The uncut solid for the kernel to measure the gross volume of: a wall a roof clips, or
        // (LS-U1) one ruled only to within 1 mm (Codex).
        const measured = s.clipBy || derived.quantities.get(e.id)?.source === 'kernel';
        elements.set(e.id, {
          node: tools.length ? idOf(e.id, 'solid') : gross,
          ...(measured ? { gross } : {}),
        });
        break;
      }
      case 'slab': {
        if (s.slope) {
          // TW5: an upright prism over the slope's whole rise, cut by the top and bottom planes.
          const { top, bottom, zLow, zHigh } = bimSlabPlanes(s);
          // 10 mm to spare each way, kept within the coordinate limit (derive checks the rise).
          const z0 = Math.max(zLow - (s.zTop - s.zBottom) - 10, -bimLimits.coordinateMm);
          const z1 = Math.min(zHigh + 10, bimLimits.coordinateMm);
          const prism = idOf(e.id, 'prism');
          nodes[prism] = {
            op: 'prism',
            frame: flat(z0),
            outer: loop(s.boundary),
            ...(s.holes.length ? { holes: s.holes.map(loop) } : {}),
            vector: [0, 0, z1 - z0],
          };
          const below = idOf(e.id, 'top');
          nodes[below] = {
            op: 'halfSpace',
            input: prism,
            origin: top.p,
            normal: top.n,
            keep: 'below',
          };
          nodes[idOf(e.id, 'solid')] = {
            op: 'halfSpace',
            input: below,
            origin: bottom.p,
            normal: bottom.n,
            keep: 'above',
          };
          elements.set(e.id, { node: idOf(e.id, 'solid') });
          break;
        }
        nodes[idOf(e.id, 'solid')] = {
          op: 'prism',
          frame: flat(s.zBottom),
          outer: loop(s.boundary),
          ...(s.holes.length ? { holes: s.holes.map(loop) } : {}),
          vector: [0, 0, s.zTop - s.zBottom],
        };
        elements.set(e.id, { node: idOf(e.id, 'solid') });
        break;
      }
      case 'space':
        nodes[idOf(e.id, 'solid')] = {
          op: 'prism',
          frame: flat(s.zBase),
          outer: loop(s.boundary),
          ...(s.holes.length ? { holes: s.holes.map(loop) } : {}),
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
          ...(s.topScale !== undefined ? { endScale: s.topScale } : {}),
        };
        let placement: BimPlacement = {
          rotation: turn(s.rotationRad),
          translation: [s.at[0], s.at[1], s.zBase],
        };
        if (s.topAt) {
          // TW2: the same section along the leaning axis, its ends square to the axis.
          const axes = bimSectionAxes(s);
          nodes[base] = {
            ...(nodes[base] as Extract<GeometryOp, { op: 'prism' }>),
            vector: [0, 0, axes.length],
          };
          placement = { rotation: axesTurn(axes), translation: axes.origin };
        }
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
        // The profile across the beam (x to the left, y up), swept along it from its start.
        const axes = bimSectionAxes(s);
        const base = idOf(e.id, 'base');
        nodes[base] = {
          op: 'prism',
          frame: flat(0),
          outer: loop(outer),
          ...(holes.length ? { holes: holes.map(loop) } : {}),
          vector: [0, 0, axes.length],
        };
        elements.set(e.id, {
          node: base,
          placement: { rotation: axesTurn(axes), translation: axes.origin },
        });
        break;
      }
      case 'member': {
        const { outer, holes } = bimProfileLoops(s.profile);
        const axes = bimSectionAxes(s);
        const base = idOf(e.id, 'base');
        nodes[base] = {
          op: 'prism',
          frame: flat(0),
          outer: loop(outer),
          ...(holes.length ? { holes: holes.map(loop) } : {}),
          vector: [0, 0, axes.length],
        };
        elements.set(e.id, {
          node: base,
          placement: { rotation: axesTurn(axes), translation: axes.origin },
        });
        break;
      }
      case 'ramp':
      case 'railing': {
        // LR3: radial rectangles every 5° (at least 8 steps), lofted smoothly. Each section's
        // plane holds the radius and the vertical: x out along the radius, y up.
        const steps = Math.max(8, Math.ceil(Math.abs(s.sweep) / bimRampStepRad));
        const base = idOf(e.id, 'base');
        nodes[base] = {
          op: 'loft',
          sections: Array.from({ length: steps + 1 }, (_, i) => {
            const t = i / steps;
            const a = s.startAngle + t * s.sweep;
            const z = s.zStart + t * (s.zEnd - s.zStart);
            const [c, n] = [Math.cos(a), Math.sin(a)];
            return {
              frame: { origin: [0, 0, 0], x: [c, n, 0], z: [n, -c, 0] },
              outer: [
                [s.innerRadius, z - s.thickness],
                [s.outerRadius, z - s.thickness],
                [s.outerRadius, z],
                [s.innerRadius, z],
              ],
            };
          }),
        };
        // LS4: openings, upright prisms through the whole rise, in the ramp's frame (its centre).
        let node = base;
        if (s.kind === 'ramp' && s.openings?.length) {
          const z0 = Math.max(
            Math.min(s.zStart, s.zEnd) - s.thickness - 10,
            -bimLimits.coordinateMm,
          );
          const z1 = Math.min(Math.max(s.zStart, s.zEnd) + 10, bimLimits.coordinateMm);
          const tools = s.openings.map((o, i) => {
            const tool = idOf(e.id, `opening${i}`);
            nodes[tool] = {
              op: 'prism',
              frame: flat(z0),
              outer: o.map((v) => {
                const p = [v[0] - s.center[0], v[1] - s.center[1]];
                return (v[2] ? [p[0], p[1], v[2]] : p) as GeometryLoop[number];
              }),
              vector: [0, 0, z1 - z0],
            };
            return tool;
          });
          node = idOf(e.id, 'solid');
          nodes[node] = { op: 'boolean', kind: 'cut', target: base, tools };
        }
        elements.set(e.id, {
          node,
          placement: { rotation: turn(0), translation: [s.center[0], s.center[1], 0] },
        });
        break;
      }
      case 'stair': {
        // LS6: its side in the upright plane along the flight, swept across its width; placed at
        // its start, turned to its direction.
        const base = idOf(e.id, 'base');
        nodes[base] = {
          op: 'prism',
          frame: { origin: [0, s.width / 2, 0], x: [1, 0, 0], z: [0, -1, 0] },
          outer: s.profile.map((p) => [p[0], p[1]] as GeometryLoop[number]),
          vector: [0, -s.width, 0],
        };
        elements.set(e.id, {
          node: base,
          placement: { rotation: turn(s.directionRad), translation: [s.at[0], s.at[1], s.zBase] },
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
    // FU3a: in a leaning wall the panel leans with it, its sill and height measured along the
    // face from the middle of the wall at the base. Its ends stay level like the ends of the
    // opening's cut, so it fits inside the cut (Codex): a prism from a level section, 50 mm thick
    // square to the face, swept up the face.
    const lean = host.lean ?? 0;
    const mid = (a.leftOff + a.rightOff) / 2 / Math.cos(lean);
    const nn = left(tangent);
    const [c, sn] = [Math.cos(lean), Math.sin(lean)];
    const sill = e.kind === 'window' ? e.sillMm : 0;
    const half = bimPanelMm / 2 / c;
    // In the panel's own frame y is left of x: the wall's left, or its right when flipped.
    const side = e.flipFacing ? -1 : 1;
    const base = idOf(e.id, 'base');
    if (lean && a.arc) {
      // On a cone the opening keeps its angles as the radius changes (Codex): the panel is the
      // band about the wall's middle between them, ruled from the sill to the head like the cut.
      const [z0, z1] = bimWallOpeningRise(host, sill, t.heightMm);
      const at = (rise: number) =>
        loop(bimWallOpeningLoop(ctx, host, e.alongMm, t.widthMm, rise, bimPanelMm / 2));
      nodes[base] = {
        op: 'loft',
        sections: [
          { frame: flat(hs.zBase + z0), outer: at(z0) },
          { frame: flat(hs.zBase + z1), outer: at(z1) },
        ],
      };
      elements.set(e.id, { node: base });
      continue;
    }
    nodes[base] = {
      op: 'prism',
      frame: flat(0),
      outer: [
        [0, -half],
        [t.widthMm, -half],
        [t.widthMm, half],
        [0, half],
      ],
      vector: [0, -side * sn * t.heightMm, c * t.heightMm],
    };
    elements.set(e.id, {
      node: base,
      placement: {
        rotation: turn(Math.atan2(x[1], x[0])),
        translation: [
          origin[0] + nn[0] * (mid - sn * sill),
          origin[1] + nn[1] * (mid - sn * sill),
          hs.zBase + c * sill,
        ],
      },
    });
  }
  return { graph: { nodes }, elements, assets };
}

/** Thickness of a door's or window's panel, as the IFC export writes it. */
export const bimPanelMm = 50;
