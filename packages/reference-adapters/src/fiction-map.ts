import {
  ReferenceError,
  svgReferenceProjection,
  type ReferenceAdapter,
} from '@editor-platform/artifact-references';
import { validateFictionMap } from '@editor-platform/fiction-map/model';
import { renderFictionMapSvg, FictionMapRenderError } from '@editor-platform/fiction-map/render';
/** Deliberate fixed-only planar projection; no Geo/CAD/node-ID conversion. */
export const fictionMapReferenceAdapter: ReferenceAdapter = {
  domain: 'fiction-map',
  modes: ['fixed'],
  validate(snapshot) {
    const r = validateFictionMap(snapshot.content);
    if (!r.ok) throw new ReferenceError('error', `Invalid Fiction Map: ${r.diagnostic.code}`);
    if (snapshot.dependencies.length)
      throw new ReferenceError('error', 'Fiction Map has no implicit World/Geo dependencies');
  },
  project(snapshot, target) {
    if (target.columnIds || target.rowIds || target.nodeIds)
      throw new ReferenceError(
        'unsupported',
        'Fiction Map targets use featureIds, not row/column/node IDs',
      );
    if (target.kind !== 'fiction-map-document' && target.kind !== 'fiction-map-view')
      throw new ReferenceError(
        'unsupported',
        'Use an explicit Fiction Map document or named view target',
      );
    if (target.kind === 'fiction-map-document' && target.viewId !== 'document')
      throw new ReferenceError('missing-target', 'Unknown document view');
    try {
      return svgReferenceProjection(
        renderFictionMapSvg(snapshot.content, {
          width: 1000,
          height: 700,
          view:
            target.kind === 'fiction-map-document'
              ? { kind: 'document' }
              : { kind: 'named', id: target.viewId },
          featureIds: target.featureIds,
        }).svg,
        'Saved Fiction Map',
      );
    } catch (e) {
      if (
        e instanceof FictionMapRenderError &&
        (e.code === 'missing-view' || e.code === 'missing-feature')
      )
        throw new ReferenceError('missing-target', e.message);
      throw new ReferenceError('error', String(e instanceof Error ? e.message : e));
    }
  },
};
