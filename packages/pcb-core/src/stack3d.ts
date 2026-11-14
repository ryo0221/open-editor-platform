import type { GeometryOp, GeometryVec3 } from '@editor-platform/geometry-core';
import type { PcbDocument, PcbStackedBoard } from './model';
import { pcbModel3d, type Pcb3dModel } from './model3d';

/**
 * PB8: a board and the boards stacked on it (`doc.stack`, each read from its own saved version)
 * as one model. A stacked board's graph is its own `pcbModel3d`, every node renamed under the
 * entry's ID, and each of its pieces is turned about z by the entry's angle and lifted so its
 * bottom face sits `gapMm` over this board's top face. Piece names start with the entry's name
 * ("Sensor HAT+ · U1 body"), and pieces keep `stacked` so the view and files can tell them apart.
 */

/** Row-major rotation and translation that place a stacked board over `base`. */
export interface PcbStackPlacement {
  rotation: number[];
  translation: GeometryVec3;
}

export function pcbStackPlacement(base: PcbDocument, entry: PcbStackedBoard): PcbStackPlacement {
  const a = (entry.rotationDeg * Math.PI) / 180;
  const c = Math.round(Math.cos(a) * 1e12) / 1e12 + 0;
  const s = Math.round(Math.sin(a) * 1e12) / 1e12 + 0;
  return {
    rotation: [c, -s + 0, 0, s, c, 0, 0, 0, 1],
    translation: [entry.at[0], entry.at[1], base.board.thicknessMm + entry.gapMm],
  };
}

/** A stacked entry with its board read: or why it could not be read (the view says so). */
export type PcbStackedSource =
  | { entry: PcbStackedBoard; doc: PcbDocument }
  | { entry: PcbStackedBoard; error: string };

function renamed(op: GeometryOp, name: (id: string) => string): GeometryOp {
  switch (op.op) {
    case 'boolean':
      return { ...op, target: name(op.target), tools: op.tools.map(name) };
    case 'transform':
    case 'halfSpace':
    case 'bodies':
      return { ...op, input: name(op.input) };
    case 'compound':
      return { ...op, inputs: op.inputs.map(name) };
    default:
      return op;
  }
}

export function pcbStackedModel3d(
  doc: PcbDocument,
  stacked: readonly PcbStackedSource[],
): Pcb3dModel {
  const own = pcbModel3d(doc);
  const nodes = { ...own.graph.nodes };
  const parts = [...own.parts];
  let omittedHoles = own.omittedHoles;
  for (const source of stacked) {
    if (!('doc' in source)) continue;
    const { entry } = source;
    const model = pcbModel3d(source.doc);
    const name = (id: string) => `stack\u0000${entry.id}\u0000${id}`;
    for (const [id, op] of Object.entries(model.graph.nodes)) nodes[name(id)] = renamed(op, name);
    const place = pcbStackPlacement(doc, entry);
    for (const p of model.parts) {
      const node = `${name(p.node)}\u0000placed`;
      nodes[node] = { op: 'transform', input: name(p.node), ...place };
      parts.push({ ...p, node, name: `${entry.name} · ${p.name}`, stacked: entry.id });
    }
    omittedHoles += model.omittedHoles;
  }
  return { graph: { nodes }, parts, omittedHoles };
}
