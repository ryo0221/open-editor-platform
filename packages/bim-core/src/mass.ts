/**
 * CS3 (docs/cad/construction-site.md): an element's mass from its volume and its materials'
 * densities, for crane lifts. Columns, beams and members are of their type's material; walls,
 * slabs and roofs of their layers, each by its share of the thickness. Other kinds (and CAD parts)
 * have no mass here.
 */
import type { BimDerived } from './derive';
import type { BimDocument } from './model';

export type BimMass =
  | { status: 'ok'; kg: number }
  /** A material it is made of has no density. */
  | { status: 'no-density'; materialIds: string[] }
  /** No volume yet: the kernel must measure it, and has not. */
  | { status: 'no-volume' }
  /** Not a kind with a mass here (openings, spaces, doors, windows, CAD parts …). */
  | { status: 'unsupported' }
  | { status: 'missing' };

/**
 * The mass of element `id` in kg. `kernelQuantities` are the evaluation's measured values, used
 * for elements whose volume only the kernel gives (clipped by a roof).
 */
export function bimElementMass(
  doc: BimDocument,
  derived: BimDerived,
  id: string,
  kernelQuantities?: ReadonlyMap<string, Record<string, number>>,
): BimMass {
  const el = doc.elements.find((e) => e.id === id);
  if (!el) return { status: 'missing' };
  const type = 'typeId' in el ? doc.types.find((t) => t.id === el.typeId) : undefined;
  if (!type) return { status: 'unsupported' };
  const materials = new Map(doc.materials.map((m) => [m.id, m]));
  let shares: [string, number][];
  if (type.kind === 'column' || type.kind === 'beam' || type.kind === 'member')
    shares = [[type.materialId, 1]];
  else if (type.kind === 'wall' || type.kind === 'slab' || type.kind === 'roof') {
    const total = type.layers.reduce((s, l) => s + l.thicknessMm, 0);
    if (!(total > 0)) return { status: 'unsupported' };
    shares = type.layers.map((l) => [l.materialId, l.thicknessMm / total]);
  } else return { status: 'unsupported' };
  const unknown = [
    ...new Set(shares.map(([m]) => m).filter((m) => materials.get(m)?.densityKgM3 === undefined)),
  ];
  if (unknown.length) return { status: 'no-density', materialIds: unknown };
  const q = derived.quantities.get(id);
  const values = { ...q?.values, ...(q?.source === 'kernel' ? kernelQuantities?.get(id) : {}) };
  const volume = values.netVolume ?? values.grossVolume;
  if (volume === undefined) return { status: 'no-volume' };
  // mm³ → m³.
  const kg = shares.reduce(
    (s, [m, f]) => s + volume * 1e-9 * f * materials.get(m)!.densityKgM3!,
    0,
  );
  return { status: 'ok', kg };
}
