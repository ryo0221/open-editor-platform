import { canonicalJson } from '@editor-platform/artifact-core';
import type { CadDocument } from '@editor-platform/cad-core';
import type { SimulationDiagnostic, SimulationDocument, SimulationTarget } from './model';

/** Whether two targets are the same, whatever the order of their properties. */
export const sameSimulationTarget = (a: SimulationTarget, b: SimulationTarget) =>
  canonicalJson(a) === canonicalJson(b);

/** Every stored target of a document with its path (loads, constraints, preparation, mesh sizes, masses, spot welds, bonds). */
export function simulationTargets(
  doc: SimulationDocument,
): { path: string; target: SimulationTarget }[] {
  const out: { path: string; target: SimulationTarget }[] = [];
  doc.loads.forEach((l, i) => {
    if (l.kind !== 'gravity')
      l.targets.forEach((t, k) => out.push({ path: `$.loads[${i}].targets[${k}]`, target: t }));
  });
  doc.constraints.forEach((c, i) =>
    c.targets.forEach((t, k) => out.push({ path: `$.constraints[${i}].targets[${k}]`, target: t })),
  );
  doc.preparation.removeFaces.forEach((t, k) =>
    out.push({ path: `$.preparation.removeFaces[${k}]`, target: t }),
  );
  doc.mesh.local.forEach((l, k) =>
    out.push({ path: `$.mesh.local[${k}].target`, target: l.target }),
  );
  (doc.masses ?? []).forEach((m, i) =>
    m.targets.forEach((t, k) => out.push({ path: `$.masses[${i}].targets[${k}]`, target: t })),
  );
  (doc.spotWelds ?? []).forEach((w, i) => {
    w.follower.forEach((t, k) => out.push({ path: `$.spotWelds[${i}].follower[${k}]`, target: t }));
    w.on.forEach((t, k) => out.push({ path: `$.spotWelds[${i}].on[${k}]`, target: t }));
  });
  (doc.bonds ?? []).forEach((b, i) => {
    b.follower.forEach((t, k) => out.push({ path: `$.bonds[${i}].follower[${k}]`, target: t }));
    b.on.forEach((t, k) => out.push({ path: `$.bonds[${i}].on[${k}]`, target: t }));
  });
  return out;
}

/**
 * What the source CAD document alone tells about an analysis (ADR 020): each analysed body (the
 * source body and, R3j-2, `bodies`) exists, is an active solid, and every target names its body's
 * result feature. The Host has already checked that `cad` is the stored version with the stored
 * content hash. Whether each name resolves on the evaluated shape is decided by evaluation (R3c),
 * never here.
 */
export function checkSimulationSource(
  doc: SimulationDocument,
  cad: CadDocument,
): SimulationDiagnostic[] {
  const out: SimulationDiagnostic[] = [];
  const features = new Map<string | undefined, string>();
  const analysed: [key: string | undefined, bodyId: string, path: string][] = [
    [undefined, doc.source.bodyId, '$.source.bodyId'],
    ...(doc.bodies ?? []).map((b, i): [string, string, string] => [
      b.bodyId,
      b.bodyId,
      `$.bodies[${i}].bodyId`,
    ]),
  ];
  for (const [key, bodyId, path] of analysed) {
    const body = cad.bodies.find((b) => b.id === bodyId);
    if (!body) {
      out.push({ code: 'source-body-missing', path, message: 'no such body' });
      continue;
    }
    if (body.state !== 'active')
      out.push({ code: 'source-body-consumed', path, message: 'consumed by a Boolean' });
    // CR5e: a sheet is analysed as a shell of the thickness the document gives it.
    if (body.kind === 'sheet' && !doc.sheets?.some((t) => t.bodyId === bodyId))
      out.push({
        code: 'source-body-kind',
        path,
        message: 'a sheet body is analysed as a shell: give it a thickness',
      });
    features.set(key, body.resultFeatureId);
  }
  // CR5e: a thickness for a body the document does not analyse.
  const analysedIds = new Set(analysed.map(([, id]) => id));
  (doc.sheets ?? []).forEach((t, i) => {
    if (!analysedIds.has(t.bodyId))
      out.push({
        code: 'sheet-body',
        path: `$.sheets[${i}].bodyId`,
        message: 'not an analysed body',
      });
    else if (cad.bodies.find((b) => b.id === t.bodyId)?.kind !== 'sheet')
      out.push({ code: 'sheet-body', path: `$.sheets[${i}].bodyId`, message: 'not a sheet body' });
  });
  // A missing source body leaves nothing its targets could be checked against.
  if (!features.has(undefined)) return out;
  for (const { path, target } of simulationTargets(doc)) {
    const featureId = features.get(target.body);
    if (featureId !== undefined && target.ref.featureId !== featureId)
      out.push({
        code: 'target-feature',
        path: `${path}.ref.featureId`,
        message: `targets name the body's result feature ${featureId}`,
      });
  }
  return out;
}
