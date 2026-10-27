/**
 * Validation of the R2b assembly fields (docs/cad/r2b-assembly.md, Assemblyの形式), run by
 * `validateCad` after the parameters: what can be checked without a kernel or the closure.
 */
import { cadAssemblyLimits, copyStep, posesDiffer, type CadSolvedPose } from './assembly';
import { validateJoints, type JointCheck } from './joints-validation';
import type { Quaternion, Vec3 } from './model';

type Rec = Record<string, unknown>;
/** The part of validation's `Check` these rules use. */
export interface AssemblyCheck extends JointCheck {
  position(v: unknown, path: string): Vec3 | undefined;
  quaternion(v: unknown, path: string): v is Quaternion;
  vec3(v: unknown, path: string): v is Vec3;
  count(v: unknown, path: string): number | undefined;
  unit(v: unknown, path: string, code: string): boolean;
}
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const reference = (v: unknown) =>
  typeof v === 'string' &&
  v.length > 0 &&
  [...v].length <= 128 &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v);

export const assemblyKeys = [
  'partProperties',
  'parts',
  'components',
  'componentPatterns',
  'joints',
  'solvedPoses',
] as const;

export function validateAssembly(c: AssemblyCheck, value: Rec) {
  const props = value.partProperties;
  if (!record(props)) c.error('part-properties', '$.partProperties');
  else if (c.keys(props, ['partNumber', 'description'], '$.partProperties')) {
    c.name(props.partNumber, '$.partProperties.partNumber');
    c.name(props.description, '$.partProperties.description');
  }
  for (const key of ['parts', 'components', 'componentPatterns', 'joints'])
    if (!Array.isArray(value[key])) return c.error('collection', `$.${key}`);
  const parts = value.parts as unknown[];
  const components = value.components as unknown[];
  if (parts.length > cadAssemblyLimits.parts) c.error('limit-parts', '$.parts');
  if (components.length > cadAssemblyLimits.components) c.error('limit-components', '$.components');

  const partIds = new Set<string>();
  const sources = new Set<string>();
  parts.forEach((p, i) => {
    const path = `$.parts[${i}]`;
    if (!record(p)) return c.error('part', path);
    c.keys(p, ['id', 'name', 'source', 'hint'], path);
    if (c.id(p.id, `${path}.id`)) partIds.add(p.id);
    c.name(p.name, `${path}.name`);
    const s = p.source;
    const sp = `${path}.source`;
    if (record(s) && s.kind === 'imported') {
      if (c.keys(s, ['kind', 'contentHash', 'sourceAssetId', 'brepAssetId', 'stepProduct'], sp)) {
        if (typeof s.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(s.contentHash))
          c.error('part-source-hash', `${sp}.contentHash`);
        if (!reference(s.sourceAssetId)) c.error('part-source', `${sp}.sourceAssetId`);
        if (!reference(s.brepAssetId)) c.error('part-source', `${sp}.brepAssetId`);
        const product = s.stepProduct;
        const pp = `${sp}.stepProduct`;
        if (!record(product) || !c.keys(product, ['id', 'name', 'description'], pp))
          c.error('part-source', pp);
        else for (const k of ['id', 'name', 'description']) c.name(product[k], `${pp}.${k}`);
        const key = JSON.stringify(['imported', s.contentHash]);
        if (sources.has(key)) c.error('part-source-duplicate', sp);
        sources.add(key);
      }
    } else if (!record(s) || s.kind !== 'version') c.error('part-source-kind', sp);
    else if (c.keys(s, ['kind', 'artifactId', 'versionId', 'contentHash'], sp)) {
      if (!reference(s.artifactId)) c.error('part-source', `${sp}.artifactId`);
      if (!reference(s.versionId)) c.error('part-source', `${sp}.versionId`);
      if (typeof s.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(s.contentHash))
        c.error('part-source-hash', `${sp}.contentHash`);
      // One definition per version: every component of it shares one evaluation.
      const key = JSON.stringify([s.artifactId, s.versionId]);
      if (sources.has(key)) c.error('part-source-duplicate', sp);
      sources.add(key);
    }
    const h = p.hint;
    const hp = `${path}.hint`;
    if (!record(h) || !c.keys(h, ['boundsMm'], hp)) return c.error('part-hint', hp);
    const b = h.boundsMm;
    if (
      !Array.isArray(b) ||
      b.length !== 2 ||
      !c.vec3(b[0], `${hp}.boundsMm[0]`) ||
      !c.vec3(b[1], `${hp}.boundsMm[1]`) ||
      !b[0].every((v, j) => v <= (b[1] as Vec3)[j]!)
    )
      c.error('part-hint', `${hp}.boundsMm`);
  });

  const used = new Set<string>();
  const fixed = new Map<string, CadSolvedPose>();
  const componentIds = new Set<string>();
  const unplaced = new Map<string, number>();
  components.forEach((x, i) => {
    const path = `$.components[${i}]`;
    if (!record(x)) return c.error('component', path);
    c.keys(x, ['id', 'name', 'partId', 'placement', 'bom'], path);
    const id = c.id(x.id, `${path}.id`) ? (x.id as string) : undefined;
    // `copy:` names a pattern copy in a path, never a component.
    if (id?.startsWith('copy:')) c.error('component-id-reserved', `${path}.id`);
    if (id) componentIds.add(id);
    c.name(x.name, `${path}.name`);
    if (typeof x.partId !== 'string' || !partIds.has(x.partId))
      c.error('component-part', `${path}.partId`);
    else used.add(x.partId);
    if (x.bom !== 'include' && x.bom !== 'exclude') c.error('component-bom', `${path}.bom`);
    const pl = x.placement;
    const pp = `${path}.placement`;
    // A joint's child has no placement: its joint places it (validateJoints).
    if (pl === null) return id && void unplaced.set(id, i);
    if (!record(pl) || !c.keys(pl, ['translation', 'rotation'], pp))
      return c.error('component-placement', pp);
    const t = c.position(pl.translation, `${pp}.translation`);
    if (c.quaternion(pl.rotation, `${pp}.rotation`) && t && id)
      fixed.set(id, { translationMm: t, rotation: pl.rotation as Quaternion });
  });
  parts.forEach(
    (p, i) =>
      record(p) &&
      partIds.has(p.id as string) &&
      !used.has(p.id as string) &&
      c.error('part-unreferenced', `$.parts[${i}]`),
  );

  // Component patterns (R2b-3): copies of a direct component, which a joint's parent may name.
  const copies = new Map<string, string>();
  let total = 0;
  (value.componentPatterns as unknown[]).forEach((x, i) => {
    const path = `$.componentPatterns[${i}]`;
    if (!record(x)) return c.error('component-pattern', path);
    c.keys(x, ['id', 'name', 'seedComponentId', 'layout'], path);
    const id = c.id(x.id, `${path}.id`) ? (x.id as string) : undefined;
    c.name(x.name, `${path}.name`);
    const seed = x.seedComponentId;
    if (typeof seed !== 'string' || !componentIds.has(seed))
      c.error('component-pattern-seed', `${path}.seedComponentId`);
    const l = x.layout;
    const lp = `${path}.layout`;
    if (!record(l) || (l.type !== 'linear' && l.type !== 'circular'))
      return c.error('pattern-layout', lp);
    if (l.type === 'linear') {
      c.keys(l, ['type', 'direction', 'count', 'spacing'], lp);
      c.unit(l.direction, `${lp}.direction`, 'pattern-direction');
      c.length(l.spacing, `${lp}.spacing`, 'dimension');
    } else {
      c.keys(l, ['type', 'axisOrigin', 'axisDirection', 'count', 'angle'], lp);
      c.position(l.axisOrigin, `${lp}.axisOrigin`);
      c.unit(l.axisDirection, `${lp}.axisDirection`, 'pattern-direction');
      c.angle(l.angle, `${lp}.angle`, 'dimension');
    }
    const n = c.count(l.count, `${lp}.count`);
    if (n === undefined) return;
    total += n;
    // Past the limit the document is refused anyway: stop listing copies so a huge import
    // does not build millions of entries first.
    if (id && typeof seed === 'string' && total <= cadAssemblyLimits.patternCopies)
      for (let k = 1; k < n; k++) copies.set(copyStep(id, k), seed);
  });
  if (total > cadAssemblyLimits.patternCopies)
    c.error('limit-pattern-copies', '$.componentPatterns');

  const results = Array.isArray(value.bodies)
    ? (value.bodies as unknown[]).flatMap((b) =>
        record(b) && b.state === 'active' && typeof b.resultFeatureId === 'string'
          ? [b.resultFeatureId]
          : [],
      )
    : [];
  validateJoints(c, value.joints as unknown[], {
    componentIds,
    copies,
    unplaced,
    ownResults: results,
  });

  const poses = value.solvedPoses;
  if (!record(poses)) return c.error('solved-poses', '$.solvedPoses');
  for (const id of componentIds)
    if (!Object.hasOwn(poses, id)) c.error('pose-missing', `$.solvedPoses.${id}`);
  for (const [id, pose] of Object.entries(poses)) {
    const path = `$.solvedPoses.${id}`;
    if (!componentIds.has(id)) {
      c.error('pose-unknown', path);
      continue;
    }
    if (!record(pose)) {
      c.error('solved-poses', path);
      continue;
    }
    if (!c.keys(pose, ['translationMm', 'rotation'], path)) continue;
    if (!c.vec3(pose.translationMm, `${path}.translationMm`)) continue;
    if (!c.quaternion(pose.rotation, `${path}.rotation`)) continue;
    // The stored pose of a fixed component is its placement now (R2b-U5): a kernel is not needed.
    const expected = fixed.get(id);
    if (expected && posesDiffer(pose as unknown as CadSolvedPose, expected))
      c.error('assembly-pose-mismatch', path);
  }
  return true;
}
