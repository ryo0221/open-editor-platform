import {
  bondedHostModel,
  type BondedHostModel,
  type BondedModalInput,
  type BondedModalResult,
  type BondedPart,
} from './bonded';
import type { CalculixModel, CalculixPart, FrdMode } from './calculix';
import {
  expandShell,
  expandShellStudy,
  foldShellDisplacement,
  type ShellExpansion,
} from './calculix-shell';
import {
  ElasticError,
  femGaussVolume,
  nodalMasses,
  prepareElastic,
  type ElasticPrepared,
} from './elastic';
import type { ModalInput, ModalMode, ModalResult } from './modal';
import {
  prepareShell,
  shellFrame,
  type ShellMesh,
  type ShellModalInput,
  type ShellModalResult,
  type ShellPrepared,
} from './shell';

/**
 * R3j-5c: the checks of the modes CalculiX gave for a modal model, from the `.frd` alone.
 * CalculiX's mass matrix is not sent back, so they use its internal forces F = K φ (`RF`), with
 * the shapes mass-normalised (φᵀ M φ = 1):
 *
 * - each mode's eigenvalue is its Rayleigh quotient λ = φᵀ F (CR0a, #895): CalculiX's printed
 *   eigenvalue can be off by a few 1e-4 on a large bonded model whose shapes are accurate (their
 *   K-orthogonality holds to 2e-5), so the frequency comes from the shape and its forces, and
 *   the printed value has to agree with it within `calculixEigenvalueAgreement`;
 * - two modes are K-orthogonal, φᵢᵀ Fⱼ / √(λᵢ λⱼ) = 0, which for eigenvectors is M-orthogonality.
 *
 * The `.frd`'s 6 significant digits leave about 1e-6 on these; `computeModalTolerance` allows
 * more for the orthogonality. The effective masses come from the editor's own mass
 * (`participation`).
 */
export const calculixEigenvalueAgreement = 1e-3;
export interface CalculixModalSummary {
  modes: {
    frequency: number;
    eigenvalue: number;
    /** x, y, z per model node. */
    shape: Float64Array;
    /** |φᵀ K φ / λ_CalculiX − 1|: how far CalculiX's printed eigenvalue is from `eigenvalue`. */
    rayleigh: number;
  }[];
  /** The largest |φᵢᵀ K φⱼ| / √(λᵢ λⱼ) over pairs of distinct modes (λ the Rayleigh quotients). */
  orthogonality: number;
}

export function calculixModalSummary(model: CalculixModel, modes: FrdMode[]): CalculixModalSummary {
  const dofs = model.nodes.length;
  const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    let s = 0;
    for (let d = 0; d < dofs; d++) s += a[d]! * b[d]!;
    return s;
  };
  // The Rayleigh quotient of each mass-normalised shape (φᵀ M φ = 1): φᵀ K φ = φᵀ F.
  const lambda = modes.map((m) => dot(m.shape, m.force));
  let orthogonality = 0;
  const out = modes.map((m, j) => {
    const lj = lambda[j]!;
    const rayleigh =
      lj > 0 && m.eigenvalue > 0 ? Math.abs(lj / m.eigenvalue - 1) : Number.POSITIVE_INFINITY;
    for (let i = 0; i < j; i++) {
      const li = lambda[i]!;
      const g =
        li > 0 && lj > 0 ? Math.abs(dot(modes[i]!.shape, m.force)) / Math.sqrt(li * lj) : Infinity;
      orthogonality = Math.max(orthogonality, g);
    }
    const frequency = lj > 0 ? Math.sqrt(lj) / (2 * Math.PI) : m.frequency;
    return { frequency, eigenvalue: lj > 0 ? lj : m.eigenvalue, shape: m.shape, rayleigh };
  });
  return { modes: out, orthogonality };
}

/**
 * φᵀ M r for a translation r in x, y, z, with the browser's mass: M r is each node's row sum
 * `masses` (`nodalMasses` for a solid, ρ t A / 3 per corner for a shell's lumped mass), so the
 * held rows' coupling counts as in `modalSummary`. `stride` is the DOFs per node of `shape`.
 */
export function participation(
  shape: ArrayLike<number>,
  masses: ArrayLike<number>,
  stride: number,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let p = 0; p < masses.length; p++)
    for (let i = 0; i < 3; i++) out[i]! += masses[p]! * shape[stride * p + i]!;
  return out;
}

/**
 * The browser's `ModalMode` of each summarised mode with `shape` in place of the model's: its
 * Rayleigh deviation as `residual` and the effective masses Γ² / `mass`.
 */
export function calculixModalModes(
  summary: CalculixModalSummary,
  mass: number,
  shape: (k: number) => Float64Array,
  gamma: (shape: Float64Array) => [number, number, number],
): ModalMode[] {
  return summary.modes.map((m, k) => {
    const phi = shape(k);
    return {
      frequency: m.frequency,
      eigenvalue: m.eigenvalue,
      shape: phi,
      residual: m.rayleigh,
      effectiveMass: gamma(phi).map((g) => (g * g) / mass) as [number, number, number],
    };
  });
}

/**
 * What every modal model refuses before it is sent, as the browser's modal solvers, and the modes
 * it asks for: at most as many as it has free DOFs (as `lowestModes` gives no more).
 */
function checkModal(
  model: CalculixModel,
  modes: number,
  describe: (d: number) => string,
): CalculixModel {
  if (!Number.isInteger(modes) || modes < 1)
    throw new RangeError('modes must be a whole number ≥ 1');
  for (const [d, v] of model.prescribed)
    if (v !== 0)
      throw new ElasticError(
        'constraint-conflict',
        `${describe(d)}: a modal study holds DOFs at 0 only`,
      );
  const fixed = new Set(model.prescribed.keys());
  for (const terms of model.equations ?? []) fixed.add(terms[0]![0]);
  if (fixed.size >= model.nodes.length)
    throw new ElasticError(
      'constraint-conflict',
      'the constraints hold every node in every direction: nothing is left to vibrate',
    );
  return { ...model, modes: Math.min(modes, model.nodes.length - fixed.size) };
}
/**
 * How many modes CalculiX gives for a modal model: those asked for, or one fewer when they are
 * all its free DOFs (its Lanczos solver stops one short; measured on a 4-DOF model).
 */
export function calculixModeCount(model: CalculixModel): { min: number; max: number } {
  const fixed = new Set(model.prescribed.keys());
  for (const terms of model.equations ?? []) fixed.add(terms[0]![0]);
  const free = model.nodes.length - fixed.size;
  const max = model.modes ?? 0;
  return { min: Math.max(1, Math.min(max, free - 1)), max };
}

const withDensity = (part: CalculixPart, density: number): CalculixPart => ({
  ...part,
  material: { ...part.material, density },
});
/** A shell's lumped nodal masses as `assembleShellMass`: ρ t A / 3 to each corner. */
const shellNodalMasses = (mesh: ShellMesh, density: number) => {
  const out = new Float64Array(mesh.nodes.length / 3);
  for (let e = 0; e < mesh.triangles.length / 3; e++) {
    const m = (density * mesh.thickness[e]! * shellFrame(mesh, e).area) / 3;
    for (let a = 0; a < 3; a++) out[mesh.triangles[3 * e + a]!]! += m;
  }
  return out;
};
const total = (masses: Float64Array) => masses.reduce((s, m) => s + m, 0);
/** CR5a: the body's own nodal masses plus the added ones. */
const plus = (own: Float64Array, added: Float64Array | undefined) => {
  if (added) own.forEach((_, p) => (own[p]! += added[p]!));
  return own;
};
/** CR5a: `[node, mass]` of the nonzero added masses, nodes through `node`. */
const massPairs = (
  added: Float64Array | undefined,
  node: (p: number) => number,
): [number, number][] => {
  const out: [number, number][] = [];
  added?.forEach((m, p) => m && out.push([node(p), m]));
  return out;
};

/** R3j-5c: a solid's modal study as CalculiX takes it, with the browser's refusals. */
export function modalHostModel(input: ModalInput): {
  model: CalculixModel;
  prepared: ElasticPrepared;
} {
  const { mesh, material } = input;
  if (!(material.density > 0)) throw new ElasticError('material', 'density > 0 for a modal study');
  const prepared = prepareElastic({
    mesh,
    material,
    constraints: input.constraints,
    masses: input.masses,
    loads: [],
  });
  const model: CalculixModel = {
    nodes: mesh.nodes,
    parts: [withDensity({ type: mesh.type, elements: mesh.elements, material }, material.density)],
    prescribed: prepared.prescribed,
    force: prepared.force,
    modes: input.modes,
    masses: massPairs(prepared.added, (p) => p),
  };
  return {
    model: checkModal(
      model,
      input.modes,
      (d) => `node ${Math.floor(d / 3)} direction ${'xyz'[d % 3]}`,
    ),
    prepared,
  };
}

/** R3j-5c: a solid's modes from the `.frd` of `modalHostModel`'s model. */
export function modalResultFromFrd(
  input: ModalInput,
  host: { model: CalculixModel; prepared: ElasticPrepared },
  frd: FrdMode[],
): ModalResult {
  const summary = calculixModalSummary(host.model, frd);
  const masses = plus(nodalMasses(input.mesh, input.material.density), host.prepared.added);
  const mass =
    input.material.density * femGaussVolume(input.mesh) +
    total(host.prepared.added ?? new Float64Array());
  return {
    modes: calculixModalModes(
      summary,
      mass,
      (k) => summary.modes[k]!.shape,
      (phi) => participation(phi, masses, 3),
    ),
    mass,
    iterations: 0,
    converged: true,
    orthogonality: summary.orthogonality,
    constrainedNodes: host.prepared.constrainedNodes,
  };
}

export interface ShellModalHostModel {
  model: CalculixModel;
  expansion: ShellExpansion;
  prepared: ShellPrepared;
}

/** R3j-5c: a shell's modal study as its 15-node wedges (`expandShell`), with the browser's refusals. */
export function shellModalHostModel(input: ShellModalInput): ShellModalHostModel {
  const { mesh, material } = input;
  if (!(material.density > 0)) throw new ElasticError('material', 'density > 0 for a modal study');
  const prepared = prepareShell({
    mesh,
    material,
    constraints: input.constraints,
    masses: input.masses,
    loads: [],
  });
  for (const [d, v] of prepared.prescribed)
    if (v !== 0)
      throw new ElasticError(
        'constraint-conflict',
        `node ${Math.floor(d / 6)}: a modal study holds DOFs at 0 only`,
      );
  const expansion = expandShell(mesh);
  const statics = expandShellStudy(mesh, expansion, material, prepared);
  const model: CalculixModel = {
    ...statics,
    parts: statics.parts.map((p) => withDensity(p, material.density)),
    modes: input.modes,
    // The middle wedge node of each shell node's first copy carries its added mass.
    masses: massPairs(prepared.added, (p) => expansion.layers[3 * p + 1]!),
  };
  return {
    model: checkModal(model, input.modes, (d) => `wedge node ${Math.floor(d / 3)}`),
    expansion,
    prepared,
  };
}

/** R3j-5c: a shell's modes (6 DOFs per node, `foldShellDisplacement`) from the wedges' `.frd`. */
export function shellModalResultFromFrd(
  input: ShellModalInput,
  host: ShellModalHostModel,
  frd: FrdMode[],
): ShellModalResult {
  const summary = calculixModalSummary(host.model, frd);
  const masses = plus(shellNodalMasses(input.mesh, input.material.density), host.prepared.added);
  const mass = total(masses);
  return {
    modes: calculixModalModes(
      summary,
      mass,
      (k) => foldShellDisplacement(host.expansion, summary.modes[k]!.shape),
      (phi) => participation(phi, masses, 6),
    ),
    mass,
    iterations: 0,
    converged: true,
    orthogonality: summary.orthogonality,
    constrainedNodes: host.prepared.constrainedNodes,
  };
}

/** R3j-5c: bonded bodies' modal study as one CalculiX model (`bondedHostModel`), loads dropped. */
export function bondedModalHostModel(input: BondedModalInput): BondedHostModel {
  input.parts.forEach((p, i) => {
    if (!(p.material.density > 0))
      throw new ElasticError('material', `part ${i}: density > 0 for a modal study`);
  });
  const parts = input.parts.map((p): BondedPart => ({ ...p, loads: [] }) as BondedPart);
  const host = bondedHostModel({ parts, bonds: input.bonds });
  // Checked on each part's own DOFs: a shell's wedges carry a held rotation about its normal as
  // nothing (θ × n = 0), so the model alone would not show it.
  host.prepared.forEach((pr, i) => {
    for (const [d, v] of pr.prescribed)
      if (v !== 0)
        throw new ElasticError(
          'constraint-conflict',
          `part ${i} DOF ${d}: a modal study holds DOFs at 0 only`,
        );
  });
  if (host.model.parts.length !== parts.length) throw new Error('one element block per part');
  const model: CalculixModel = {
    ...host.model,
    parts: host.model.parts.map((p, i) => withDensity(p, parts[i]!.material.density)),
    modes: input.modes,
    masses: host.prepared.flatMap((pr, i) => {
      const { base, expansion } = host.layout[i]!;
      return massPairs(pr.added, (p) => base + (expansion ? expansion.layers[3 * p + 1]! : p));
    }),
  };
  return { ...host, model: checkModal(model, input.modes, (d) => `DOF ${d}`) };
}

/** R3j-5c: bonded bodies' modes per part from the `.frd` of `bondedModalHostModel`'s model. */
export function bondedModalResultFromFrd(
  input: BondedModalInput,
  host: BondedHostModel,
  frd: FrdMode[],
): BondedModalResult {
  const summary = calculixModalSummary(host.model, frd);
  const nodal = input.parts.map((p, i) =>
    plus(
      p.kind === 'shell'
        ? shellNodalMasses(p.mesh, p.material.density)
        : nodalMasses(p.mesh, p.material.density),
      host.prepared[i]!.added,
    ),
  );
  const partMasses = input.parts.map((p, i) =>
    p.kind === 'shell'
      ? total(nodal[i]!)
      : p.material.density * femGaussVolume(p.mesh) +
        total(host.prepared[i]!.added ?? new Float64Array()),
  );
  const mass = partMasses.reduce((s, m) => s + m, 0);
  return {
    modes: summary.modes.map((m) => {
      const shapes = input.parts.map((p, i) => {
        const { base, count, expansion } = host.layout[i]!;
        const U = m.shape.subarray(3 * base, 3 * (base + count));
        return p.kind === 'shell' ? foldShellDisplacement(expansion!, U) : Float64Array.from(U);
      });
      // A translation of every part follows the bonds, so φᵀ M r sums over the parts.
      const gamma: [number, number, number] = [0, 0, 0];
      shapes.forEach((phi, i) => {
        const g = participation(phi, nodal[i]!, input.parts[i]!.kind === 'shell' ? 6 : 3);
        for (let k = 0; k < 3; k++) gamma[k]! += g[k]!;
      });
      return {
        frequency: m.frequency,
        eigenvalue: m.eigenvalue,
        residual: m.rayleigh,
        effectiveMass: gamma.map((g) => (g * g) / mass) as [number, number, number],
        shapes,
      };
    }),
    mass,
    partMasses,
    bonds: host.bonds,
    dofs: host.model.nodes.length - (host.model.equations?.length ?? 0),
    iterations: 0,
    converged: true,
    orthogonality: summary.orthogonality,
    constrainedNodes: host.prepared.map((p) => p.constrainedNodes),
  };
}
