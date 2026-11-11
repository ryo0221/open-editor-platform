import { nodesPerElement, type FemMesh } from './fem';
import {
  boundaryFaceList,
  boundaryFacePoints,
  ElasticError,
  gaussPoints,
  gaussWeight,
  jacobianRatio,
  meshComponents,
  shapeGradients,
  tet10Natural,
} from './elastic';
import { CsrMatrix, csrPattern, pcg } from './sparse';

/**
 * Steady heat conduction in an isotropic solid on a FEM 1 mesh (R3h-1, docs/cad/r3-analysis.md
 * 解法と検査). Units follow mm–N–MPa–t–s: power is mW (N·mm/s), so a conductivity in mW/(mm·K) is
 * the same number in W/(m·K); a flux in mW/mm² is kW/m²; a film coefficient in mW/(mm²·K) is
 * kW/(m²·K). Temperatures are K (any offset works: only differences enter, and ambient values).
 */
export interface ThermalMaterial {
  /** mW/(mm·K) = W/(m·K). */
  conductivity: number;
}

/** A thermal condition on shape faces (and, for a temperature, shape edges). */
export type ThermalCondition =
  /** A fixed temperature (K) on the nodes of the faces and edges. */
  | { kind: 'temperature'; faces: number[]; edges: number[]; temperature: number }
  /** A heat flux into the body (mW/mm²) on the faces; negative takes heat out. */
  | { kind: 'heat-flux'; faces: number[]; flux: number }
  /** Convection h (T∞ − T) into the body on the faces: h in mW/(mm²·K), T∞ in K. */
  | { kind: 'convection'; faces: number[]; coefficient: number; ambient: number };

export interface ThermalInput {
  mesh: FemMesh;
  material: ThermalMaterial;
  conditions: ThermalCondition[];
  solver: { tolerance: number; maxIterations: number };
}

export interface ThermalResult {
  /** K per node. */
  temperature: Float64Array;
  /** The heat flux q = −k ∇T per node (mW/mm²), x, y, z, averaged over the elements around it. */
  flux: Float64Array;
  /** |q| per node (mW/mm²). */
  fluxMagnitude: Float64Array;
  /**
   * The heat each condition puts into the body (mW; negative takes it out) and its area (mm²; 0
   * for a temperature held on edges only). A held temperature's heat is the nodal reaction; a node
   * held by two conditions counts for the first.
   */
  conditionChecks: { heat: number; measure: number }[];
  /** Nodes each temperature condition holds (0 for the others). */
  constrainedNodes: number[];
  /** Sum of the conditions' heat (mW): 0 in steady state, up to the solver's accuracy. */
  balance: number;
  /** The largest heat any condition moves (mW), the scale for `balance`. */
  heatScale: number;
  iterations: number;
  residual: number;
  converged: boolean;
}

/** The conduction matrix K_ab = ∫ k ∇N_a · ∇N_b dV (mW/K), one DOF per node. */
export function assembleConduction(mesh: FemMesh, conductivity: number): CsrMatrix {
  const npe = nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  const m = mesh.elements.length / npe;
  const conn = (e: number) => mesh.elements.subarray(e * npe, (e + 1) * npe);
  const K = new CsrMatrix(csrPattern(n, m, conn, npe, 1));
  const ke = new Float64Array(npe * npe);
  for (let e = 0; e < m; e++) {
    ke.fill(0);
    for (const g of gaussPoints) {
      const { dN, det } = shapeGradients(mesh, e, npe, g);
      const w = det * gaussWeight * conductivity;
      for (let a = 0; a < npe; a++)
        for (let b = 0; b < npe; b++)
          ke[a * npe + b]! +=
            w * (dN[a]![0]! * dN[b]![0]! + dN[a]![1]! * dN[b]![1]! + dN[a]![2]! * dN[b]![2]!);
    }
    const nodes = conn(e);
    for (let a = 0; a < npe; a++)
      for (let b = 0; b < npe; b++) K.add(nodes[a]!, nodes[b]!, ke[a * npe + b]!);
  }
  return K;
}

/**
 * Solves K T = Q with the held temperatures eliminated. Refuses before solving: a conductivity or
 * film coefficient that is not positive, a non-finite value (`material`); no held temperature and
 * no convection (`no-constraint`); a connected piece with neither (`rigid-body-mode`: its
 * temperature would float); a condition on no face (`empty-target`); two temperatures on one node
 * (`constraint-conflict`); a folded curved element (`mesh-quality`).
 */
export function solveThermal(input: ThermalInput): ThermalResult {
  const { mesh, material, conditions } = input;
  const k = material.conductivity;
  if (!(k > 0) || !Number.isFinite(k)) throw new ElasticError('material', 'conductivity > 0');
  conditions.forEach((c, i) => {
    const values =
      c.kind === 'temperature'
        ? [c.temperature]
        : c.kind === 'heat-flux'
          ? [c.flux]
          : [c.coefficient, c.ambient];
    if (!values.every(Number.isFinite))
      throw new ElasticError('material', `condition ${i} has a value that is not finite`);
    if (c.kind === 'convection' && !(c.coefficient > 0))
      throw new ElasticError('material', `condition ${i}: film coefficient > 0`);
  });
  const npe = nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  const m = mesh.elements.length / npe;
  if (mesh.type === 'tet10')
    for (let e = 0; e < m; e++)
      if (!(jacobianRatio(mesh, e) > 0))
        throw new ElasticError('mesh-quality', `element ${e} may fold (det J bound ≤ 0)`);
  if (!conditions.some((c) => c.kind !== 'heat-flux'))
    throw new ElasticError(
      'no-constraint',
      'no held temperature or convection sets the temperature level',
    );

  // Held temperatures → nodes.
  const held = new Map<number, number>();
  const heldBy = new Map<number, number>();
  const constrainedNodes: number[] = [];
  const faceSets = conditions.map((c, ci) => {
    const faces = boundaryFaceList(mesh, c.faces);
    if (c.kind !== 'temperature' && !faces.length)
      throw new ElasticError('empty-target', `condition ${ci} is on no face`);
    return faces;
  });
  conditions.forEach((c, ci) => {
    if (c.kind !== 'temperature') return constrainedNodes.push(0);
    const nodes = new Set<number>();
    for (const { e, lf } of faceSets[ci]!)
      for (const p of boundaryFacePoints(mesh, e, lf).nodes) nodes.add(p);
    for (const edge of c.edges) {
      if (!Number.isInteger(edge) || edge < 0 || edge >= mesh.shapeEdges)
        throw new ElasticError('target-index', `edge ${edge} is not in 0..${mesh.shapeEdges - 1}`);
      for (const p of mesh.edges.nodes.subarray(
        mesh.edges.offsets[edge]!,
        mesh.edges.offsets[edge + 1]!,
      ))
        nodes.add(p);
    }
    if (!nodes.size) throw new ElasticError('empty-target', `condition ${ci} holds no node`);
    constrainedNodes.push(nodes.size);
    for (const p of nodes) {
      const before = held.get(p);
      if (before !== undefined && before !== c.temperature)
        throw new ElasticError(
          'constraint-conflict',
          `condition ${ci} gives node ${p} ${c.temperature} K, another gave ${before} K`,
        );
      held.set(p, c.temperature);
      if (!heldBy.has(p)) heldBy.set(p, ci);
    }
  });

  // Each connected piece needs a held temperature or a convection face of its own.
  const pieces = meshComponents(mesh);
  const anchored = new Uint8Array(pieces.count);
  for (const p of held.keys()) anchored[pieces.label[p]!] = 1;
  conditions.forEach((c, ci) => {
    if (c.kind === 'convection')
      for (const { e } of faceSets[ci]!) anchored[pieces.label[mesh.elements[e * npe]!]!] = 1;
  });
  const loose = [...anchored.keys()].filter((p) => !anchored[p]);
  if (loose.length)
    throw new ElasticError(
      'rigid-body-mode',
      `piece ${loose[0]! + 1} of ${pieces.count} has no held temperature or convection`,
      ['temperature'],
    );

  // Assembly: conduction, convection h ∫ N_a N_b dA, and the face heat.
  const K = assembleConduction(mesh, k);
  const Q = new Float64Array(n);
  const measures = conditions.map(() => 0);
  conditions.forEach((c, ci) => {
    if (c.kind === 'temperature') {
      for (const { e, lf } of faceSets[ci]!)
        for (const { normal } of boundaryFacePoints(mesh, e, lf).points)
          measures[ci]! += Math.hypot(...normal);
      return;
    }
    for (const { e, lf } of faceSets[ci]!) {
      const { nodes, points } = boundaryFacePoints(mesh, e, lf);
      for (const { N, normal } of points) {
        const dA = Math.hypot(...normal);
        measures[ci]! += dA;
        if (c.kind === 'heat-flux') N.forEach((na, a) => (Q[nodes[a]!]! += c.flux * na * dA));
        else
          N.forEach((na, a) => {
            Q[nodes[a]!]! += c.coefficient * c.ambient * na * dA;
            N.forEach((nb, b) => K.add(nodes[a]!, nodes[b]!, c.coefficient * na * nb * dA));
          });
      }
    }
  });

  // Elimination of the held temperatures, solving for the difference from a reference (the mean
  // held or ambient temperature): the right-hand side then holds only what drives heat, so the
  // PCG's relative tolerance measures the heat flow, not the absolute temperature level.
  const levels = [
    ...held.values(),
    ...conditions.flatMap((c) => (c.kind === 'convection' ? [c.ambient] : [])),
  ];
  const reference = levels.reduce((s, v) => s + v, 0) / levels.length;
  const T = new Float64Array(n).fill(reference);
  const free = new Uint8Array(n).fill(1);
  for (const [p, v] of held) {
    T[p] = v;
    free[p] = 0;
  }
  const KT0 = K.multiply(T);
  const b = new Float64Array(n);
  for (let p = 0; p < n; p++) b[p] = free[p] ? Q[p]! - KT0[p]! : 0;
  const solved = pcg(K, b, free, input.solver.tolerance, input.solver.maxIterations);
  for (let p = 0; p < n; p++) if (free[p]) T[p]! += solved.x[p]!;

  // Heat by condition: reactions at held nodes, the flux, and h (T∞ − T) at the faces.
  const KT = K.multiply(T);
  const heat = conditions.map(() => 0);
  for (const [p, ci] of heldBy) heat[ci]! += KT[p]! - Q[p]!;
  conditions.forEach((c, ci) => {
    if (c.kind === 'heat-flux') heat[ci] = c.flux * measures[ci]!;
    if (c.kind !== 'convection') return;
    for (const { e, lf } of faceSets[ci]!) {
      const { nodes, points } = boundaryFacePoints(mesh, e, lf);
      for (const { N, normal } of points) {
        const t = N.reduce((s, na, a) => s + na * T[nodes[a]!]!, 0);
        heat[ci]! += c.coefficient * (c.ambient - t) * Math.hypot(...normal);
      }
    }
  });

  // Flux at the nodes of each element, averaged.
  const flux = new Float64Array(3 * n);
  const count = new Uint32Array(n);
  // Corners, then the mid-edge nodes in `tet10Edges` order (the element connectivity's).
  const natural = tet10Natural;
  for (let e = 0; e < m; e++) {
    const nodes = mesh.elements.subarray(e * npe, (e + 1) * npe);
    for (let a = 0; a < npe; a++) {
      const { dN } = shapeGradients(mesh, e, npe, natural[a]!);
      const p = nodes[a]!;
      for (let d = 0; d < 3; d++)
        flux[p * 3 + d]! -= k * dN.reduce((s, g, b) => s + g[d]! * T[nodes[b]!]!, 0);
      count[p]!++;
    }
  }
  const fluxMagnitude = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    for (let d = 0; d < 3; d++) flux[p * 3 + d]! /= Math.max(1, count[p]!);
    fluxMagnitude[p] = Math.hypot(flux[p * 3]!, flux[p * 3 + 1]!, flux[p * 3 + 2]!);
  }
  return {
    temperature: T,
    flux,
    fluxMagnitude,
    conditionChecks: heat.map((h, i) => ({ heat: h, measure: measures[i]! })),
    constrainedNodes,
    balance: heat.reduce((s, h) => s + h, 0),
    heatScale: Math.max(0, ...heat.map(Math.abs)),
    iterations: solved.iterations,
    residual: solved.residual,
    converged: solved.converged,
  };
}
