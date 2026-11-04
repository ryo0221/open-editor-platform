import { canonicalJson } from '@editor-platform/artifact-core';
import { admit, admitAt, isOwnedContent } from './admission';
import { copyData, requestBudget } from './input';
import { fictionMapLimits, type WorkLedger } from './limits';
import { readJson } from './json';
import { attempt, fail, pointer, unwrap } from './result';
import { record, text } from './schema';
import type { FictionMapContent } from './types';

export interface FictionMapIdRemap {
  readonly from: string;
  readonly to: string;
}
export interface FictionMapImportOptions {
  readonly mode: 'replace' | 'append';
  readonly remap?: {
    readonly layers?: readonly FictionMapIdRemap[];
    readonly features?: readonly FictionMapIdRemap[];
    readonly namedViews?: readonly FictionMapIdRemap[];
  };
}
export function readImportOptions(input: unknown): FictionMapImportOptions {
  const o = record(copyData(input, requestBudget), '', ['mode'], ['remap']);
  if (o.mode !== 'replace' && o.mode !== 'append') fail('invalid-field', '/mode');
  if (!Object.hasOwn(o, 'remap')) return { mode: o.mode };
  if (o.mode === 'replace') fail('invalid-remap', '/remap');
  const r = record(o.remap, '/remap', [], ['layers', 'features', 'namedViews']);
  const result: Record<string, readonly FictionMapIdRemap[]> = {};
  for (const scope of ['layers', 'features', 'namedViews'])
    if (Object.hasOwn(r, scope)) {
      if (!Array.isArray(r[scope])) fail('invalid-remap', '/remap/' + scope);
      result[scope] = (r[scope] as unknown[]).map((v, i) => {
        const p = `/remap/${scope}/${i}`,
          pair = record(v, p, ['from', 'to']);
        return { from: text(pair.from, p + '/from'), to: text(pair.to, p + '/to') };
      });
    }
  return { mode: o.mode, remap: result };
}
function remapIds(
  source: readonly { readonly id: string }[],
  target: readonly { readonly id: string }[],
  mapping: readonly FictionMapIdRemap[] | undefined,
  path: string,
): Map<string, string> {
  const sourceIds = new Set(source.map((x) => x.id)),
    dest = new Set(target.map((x) => x.id)),
    m = new Map<string, string>();
  mapping?.forEach((pair, i) => {
    if (!sourceIds.has(pair.from) || m.has(pair.from)) fail('invalid-remap', pointer(path, i));
    m.set(pair.from, pair.to);
  });
  for (const [i, item] of source.entries()) {
    const id = m.get(item.id) ?? item.id;
    if (dest.has(id)) fail(mapping ? 'invalid-remap' : 'duplicate-id', pointer(path, i), { id });
    dest.add(id);
    m.set(item.id, id);
  }
  return m;
}
/** Pure import builder used by the later prepare boundary; no native publication. */
export function mergeNative(
  base: FictionMapContent,
  input: unknown,
  options: unknown,
): FictionMapContent {
  if (!isOwnedContent(base)) fail('invalid-data', '/base/content');
  const opts = readImportOptions(options);
  const raw =
    typeof input === 'string' || input instanceof Uint8Array
      ? unwrap(attempt('source', () => readJson(input)))
      : input;
  copyData({ content: raw, options: opts }, requestBudget);
  const ledger: WorkLedger = {
    pairs: 0,
    passes: 0,
    maxPairs: opts.mode === 'append' ? fictionMapLimits.appendPairs : fictionMapLimits.passPairs,
    maxPasses: opts.mode === 'append' ? 2 : 1,
  };
  const source = unwrap(admitAt(raw, 'source', undefined, ledger));
  if (opts.mode === 'replace') return source;
  if (
    canonicalJson(base.coordinateSpace) !== canonicalJson(source.coordinateSpace) ||
    canonicalJson(base.precision) !== canonicalJson(source.precision)
  )
    fail('import-space-mismatch', '/coordinateSpace');
  const layers = remapIds(source.layers, base.layers, opts.remap?.layers, '/remap/layers');
  const features = remapIds(
    source.features,
    base.features,
    opts.remap?.features,
    '/remap/features',
  );
  const views = remapIds(
    source.namedViews,
    base.namedViews,
    opts.remap?.namedViews,
    '/remap/namedViews',
  );
  return admit(
    {
      ...base,
      layers: [...base.layers, ...source.layers.map((l) => ({ ...l, id: layers.get(l.id)! }))],
      features: [
        ...base.features,
        ...source.features.map((f) => ({
          ...f,
          id: features.get(f.id)!,
          layerId: layers.get(f.layerId)!,
        })),
      ],
      namedViews: [
        ...base.namedViews,
        ...source.namedViews.map((v) => ({
          ...v,
          id: views.get(v.id)!,
          visibleLayerIds: v.visibleLayerIds.map((id) => layers.get(id)!),
        })),
      ],
    },
    base,
    ledger,
  );
}
