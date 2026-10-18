/** Private per-scope provenance guard, not a history implementation.
 * Caller admits only originals already verified by import hashing or checkedSourceEnvelope.
 * This Host adds sources only through adopted imports; point edits preserve source/ref
 * identity and ordinary Undo/Redo only revisit those states. Thus the union of EVERY
 * adopted source/ref in this scope is a conservative superset of reachable history.
 * Never prune it on Undo, deletion, or branch changes. A reopened document gets a new
 * profile and a new EditorSession; discard the old profile only when its scope closes.
 */
import type { DeepReadonly, GeoDocument, SourceSnapshot } from '@editor-platform/geo-core';
import type { GeoPointEditProfile } from '@editor-platform/geo-inspector/point-edit';
import type { SourceClosure } from './geo-source-envelope';
type Requirement = { identity: string; resourceId: string; closure: string };
const identity = (value: unknown) => JSON.stringify(value);
function corresponding(source: DeepReadonly<SourceSnapshot>, closure: SourceClosure | undefined) {
  return (
    !!closure &&
    closure.sourceId === source.id &&
    closure.resourceId === source.resourceId &&
    closure.pin.artifactId === source.pin.artifactId &&
    closure.pin.versionId === source.pin.versionId &&
    closure.pin.contentHash === source.pin.contentHash &&
    closure.sourceVersion.artifactId === source.pin.artifactId &&
    closure.sourceVersion.versionId === source.pin.versionId &&
    'sha256:' + closure.sourceVersion.contentHash === source.pin.contentHash &&
    closure.sourceVersion.content.bytesHash === source.bytesHash &&
    closure.sourceVersion.content.format === source.format
  );
}
export function createSourceProfile(options: {
  current(): void;
  originals: Map<string, SourceClosure>;
  allowManualFeatures?: boolean;
}) {
  const sources = new Map<string, Requirement>();
  const features = new Map<string, { identity: string; variants?: Set<string> }>();
  let epoch = 0;
  const healthy = () => {
    options.current();
    for (const source of sources.values()) {
      const closure = options.originals.get(source.resourceId);
      if (!closure || identity(closure) !== source.closure) throw Error('GeoSourceHistoryClosure');
    }
  };
  const featureEntries = (content: DeepReadonly<GeoDocument>) =>
    content.layers.flatMap((layer) =>
      layer.features.map((feature) => ({
        key: identity([layer.id, feature.id]),
        identity: identity([layer.id, feature.id, feature.rowId, feature.sourceRef ?? null]),
        sourceId: feature.sourceRef?.sourceId,
      })),
    );
  const admitted = (content: DeepReadonly<GeoDocument>) => {
    const present = new Set<string>();
    for (const source of content.sources) {
      const retained = sources.get(source.id);
      if (present.has(source.id) || !retained || retained.identity !== identity(source))
        throw Error('GeoSourceNotAdopted');
      present.add(source.id);
    }
    const seen = new Set<string>();
    for (const feature of featureEntries(content)) {
      if (
        seen.has(feature.key) ||
        (!(options.allowManualFeatures && !feature.sourceId && !features.has(feature.key)) &&
          features.get(feature.key)?.identity !== feature.identity &&
          !features.get(feature.key)?.variants?.has(feature.identity)) ||
        (feature.sourceId !== undefined && !present.has(feature.sourceId))
      )
        throw Error('GeoSourceRefNotAdopted');
      seen.add(feature.key);
    }
  };
  const checkHistory = (): boolean => {
    try {
      healthy();
      return true;
    } catch {
      return false;
    }
  };
  const profile: GeoPointEditProfile = Object.freeze({
    kind: 'retained-source-closure' as const,
    check(content: DeepReadonly<GeoDocument>, intent: 'edit' | 'history') {
      if (intent !== 'edit' && intent !== 'history') return false;
      try {
        healthy();
        admitted(content);
        return true;
      } catch {
        return false;
      }
    },
  });
  return Object.freeze({
    profile,
    checkHistory,
    /** Call before a native import commit; rollback ONLY if that commit did not apply.
     * No async work or another adoption may intervene before rollback. Existing adopted
     * requirements are never replaced, even when absent from the current document. */
    adopt(content: GeoDocument, refresh = false): () => void {
      healthy();
      const addedSources = new Map<string, Requirement>();
      const addedFeatures = new Map<string, { identity: string }>();
      const variants: { key: string; identity: string }[] = [];
      const present = new Set<string>();
      for (const source of content.sources) {
        if (present.has(source.id)) throw Error('GeoSourceDuplicate');
        present.add(source.id);
        const closure = options.originals.get(source.resourceId);
        if (!corresponding(source, closure)) throw Error('GeoSourceAdoptionClosure');
        const requirement = {
          identity: identity(source),
          resourceId: source.resourceId,
          closure: identity(closure),
        };
        const previous = sources.get(source.id);
        if (
          previous &&
          (previous.identity !== requirement.identity || previous.closure !== requirement.closure)
        )
          throw Error('GeoSourceIdentityChanged');
        if (!previous) {
          if (
            [...sources.values(), ...addedSources.values()].some(
              (s) => s.resourceId === source.resourceId,
            )
          )
            throw Error('GeoSourceResourceConflict');
          addedSources.set(source.id, requirement);
        }
      }
      const seen = new Set<string>();
      for (const feature of featureEntries(content)) {
        if (
          seen.has(feature.key) ||
          (feature.sourceId !== undefined && !present.has(feature.sourceId))
        )
          throw Error('GeoSourceAdoptionRef');
        seen.add(feature.key);
        const previous = features.get(feature.key);
        if (
          previous &&
          previous.identity !== feature.identity &&
          !previous.variants?.has(feature.identity)
        ) {
          const prior = JSON.parse(previous.identity) as [
            string,
            string,
            string,
            { sourceId: string; externalId: unknown } | null,
          ];
          const next = JSON.parse(feature.identity) as typeof prior;
          if (
            !refresh ||
            prior[0] !== next[0] ||
            prior[1] !== next[1] ||
            prior[2] !== next[2] ||
            !prior[3] ||
            !next[3] ||
            JSON.stringify(prior[3].externalId) !== JSON.stringify(next[3].externalId)
          )
            throw Error('GeoSourceRefChanged');
          variants.push({ key: feature.key, identity: feature.identity });
        }
        if (!previous) addedFeatures.set(feature.key, { identity: feature.identity });
      }
      for (const [key, entry] of addedSources) sources.set(key, entry);
      for (const [key, entry] of addedFeatures) features.set(key, entry);
      for (const variant of variants) {
        const entry = features.get(variant.key)!;
        entry.variants ??= new Set();
        entry.variants.add(variant.identity);
      }
      const ticket = ++epoch;
      let released = false;
      return () => {
        if (released) return;
        if (ticket !== epoch) throw Error('GeoSourceRollbackAfterAdoption');
        released = true;
        for (const [key, entry] of addedSources)
          if (sources.get(key) === entry) sources.delete(key);
        for (const [key, entry] of addedFeatures)
          if (features.get(key) === entry) features.delete(key);
        for (const variant of variants)
          features.get(variant.key)?.variants?.delete(variant.identity);
      };
    },
  });
}
