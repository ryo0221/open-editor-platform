/**
 * CR3e (docs/cad/car-design.md): "Make part" turns an active body into a part. The body's closure
 * (its upstream features, the sketches, profiles and parameters they read, and the bodies they
 * consumed) becomes the content of a new `cad` Artifact version; in the original document the
 * body, and what only it needed, is replaced by a component placing that version at the origin.
 */
import { clone } from '@editor-platform/artifact-core';
import { emptyCad, type CadDocument } from './model';
import { dependencyClosure, duplicateClosureOf } from './operations';

const fail = (code: string): never => {
  throw new Error(code);
};

/** The closure of one active body that a part can hold, refused when it reads stored assets. */
function partClosure(doc: CadDocument, bodyId: string) {
  const body = doc.bodies.find((b) => b.id === bodyId) ?? fail('target-missing');
  if (body.state !== 'active') fail('body-consumed');
  const closure = duplicateClosureOf(doc, [bodyId]);
  // A STEP import's B-rep and a texture image are bytes the Host keeps for this Artifact only.
  if (doc.features.some((f) => closure.features.has(f.id) && f.type === 'imported'))
    fail('make-part-imported');
  if (closure.copiedBodies.some((b) => b.appearance.textures)) fail('make-part-textures');
  return closure;
}

/**
 * The content of the part's first version: the body's closure in a new document with the same
 * kernel profile (exact build and tolerance set), in the same coordinates, so the component at
 * the origin stands where the body stood.
 */
export function bodyPartContent(doc: CadDocument, bodyId: string): CadDocument {
  const { parameters, profiles, sketches, features, copiedBodies } = partClosure(doc, bodyId);
  return clone({
    ...emptyCad(doc.kernelProfile),
    kernelProfile: doc.kernelProfile,
    parameters: doc.parameters.filter((p) => parameters.has(p.id)),
    profiles: doc.profiles.filter((p) => profiles.has(p.id)),
    sketches: doc.sketches.filter((s) => sketches.has(s.id)),
    features: doc.features.filter((f) => features.has(f.id)),
    bodies: copiedBodies,
  });
}

/**
 * What leaves the original document: the body's closure less what another active body's closure
 * holds (a skin the door was cut from stays). Parameters stay, as other edits may read them.
 * Refused while anything left depends on what leaves (`make-part-has-dependents`).
 */
export function makePartRemoval(doc: CadDocument, bodyId: string) {
  const own = partClosure(doc, bodyId);
  const others = doc.bodies.filter((b) => b.state === 'active' && b.id !== bodyId);
  const kept = others.length
    ? duplicateClosureOf(
        doc,
        others.map((b) => b.id),
      )
    : undefined;
  const leaves = <T extends string>(ids: Set<T>, keep: Set<T> | undefined) =>
    new Set([...ids].filter((id) => !keep?.has(id)));
  const removal = {
    profiles: leaves(own.profiles, kept?.profiles),
    sketches: leaves(own.sketches, kept?.sketches),
    features: leaves(own.features, kept?.features),
    bodies: new Set(
      own.copiedBodies
        .map((b) => b.id)
        .filter((id) => !kept?.copiedBodies.some((b) => b.id === id)),
    ),
  };
  const all = new Set([
    ...removal.profiles,
    ...removal.sketches,
    ...removal.features,
    ...removal.bodies,
  ]);
  const dependents = dependencyClosure(doc, all);
  const extra = [
    ...dependents.parameters,
    ...dependents.profiles,
    ...dependents.sketches,
    ...dependents.features,
    ...dependents.bodies,
    ...dependents.components,
    ...dependents.patterns,
    ...dependents.joints,
  ].filter((id) => !all.has(id));
  if (extra.length) fail('make-part-has-dependents');
  return removal;
}
