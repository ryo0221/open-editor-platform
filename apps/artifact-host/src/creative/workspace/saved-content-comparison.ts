/** Domain-specific retained content comparison. No time, knowledge or causality inference. */
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { isDocument } from '@editor-platform/document/model';
import { cellValue, isStructuredData, validateData } from '@editor-platform/structured-data/model';
import {
  characterFields,
  projectCharacterCards,
  type CharacterColumnMapping,
} from '../character-source-read';
import type { TimelineSavedFacet } from '../timeline/saved-comparison';
import type { Exact, TimelineSavedComparisonSource } from '../timeline/analysis-context';
import { TL1_LIMITS } from '../timeline/tl1-schema';

export type CreativeSavedContentRequest = {
  before: Exact;
  after: Exact;
  facets: string[];
} & (
  | { domain: 'document-block' }
  | {
      domain: 'character';
      beforeColumns: CharacterColumnMapping;
      afterColumns: CharacterColumnMapping;
    }
);

/** Uses the same retained reader and access guards as Timeline. LO uses compareTimelineSetting. */
export async function compareCreativeSavedContent(
  w: TimelineSavedComparisonSource,
  request: CreativeSavedContentRequest,
) {
  const input = structuredClone(request);
  if (
    new TextEncoder().encode(canonicalJson(input)).byteLength > TL1_LIMITS.projectionBytes ||
    !['document-block', 'character'].includes(input.domain) ||
    input.before.type !== 'exact' ||
    input.after.type !== 'exact' ||
    !input.before.item ||
    input.before.artifact !== input.after.artifact ||
    input.before.item !== input.after.item ||
    !input.facets.length ||
    input.facets.some((f) => typeof f !== 'string')
  )
    throw Error('保存版内容比較の対象が不正です。');
  const access = w.captureAccess(input.before.artifact),
    links = canonicalJson(w.links);
  const current = () => access() && canonicalJson(w.links) === links;
  const assertCurrent = () => {
    if (!current() || !w.readable(input.before.artifact))
      throw Error('保存版内容比較の入力・権限を確認できません。');
  };
  assertCurrent();
  const artifact = await w.source.get(input.before.artifact);
  assertCurrent();
  const read = async (ref: Exact, side: 'before' | 'after') => {
    const versions = artifact?.versions.filter((v) => v.versionId === ref.version);
    if (!versions || versions.length !== 1 || artifact?.id !== ref.artifact) return undefined;
    const v = versions[0];
    if (v.contentHash !== ref.hash || (await contentHash(v.content)) !== ref.hash) return undefined;
    if (input.domain === 'document-block') {
      if (artifact.kind !== 'document' || !isDocument(v.content)) return undefined;
      return {
        item: v.content.blocks.find((b) => b.id === ref.item),
        fields: undefined,
        unresolved: new Set<string>(),
      };
    }
    if (artifact.kind !== 'data' || !isStructuredData(v.content)) return undefined;
    const columns = side === 'before' ? input.beforeColumns : input.afterColumns;
    try {
      const card = projectCharacterCards(v.content, columns).find((c) => c.id === ref.item);
      const row = card && v.content.rows.find((r) => r.id === card.elementId);
      const unresolved = new Set<string>();
      const fields: Record<string, string> = {};
      if (row) {
        const invalid = new Set(validateData(v.content, [row]).map((e) => e.columnId));
        for (const [field] of characterFields) {
          const column = v.content.columns.find((c) => c.id === columns[field])!;
          try {
            if (invalid.has(column.id)) {
              unresolved.add(field);
              continue;
            }
            // Keep native display semantics, but never turn evaluation errors into '#ERROR'.
            fields[field] = String(cellValue(v.content, row, column) ?? '');
          } catch {
            unresolved.add(field);
          }
        }
      }
      return { item: card ? { elementId: card.elementId, fields } : undefined, fields, unresolved };
    } catch {
      return undefined;
    }
  };
  const a = await read(input.before, 'before'),
    b = await read(input.after, 'after');
  assertCurrent();
  const facets: TimelineSavedFacet[] = [...new Set(input.facets)].map((facet) => {
    const field = facet.startsWith('field:') ? facet.slice(6) : undefined;
    if (
      !['existence', 'content'].includes(facet) &&
      !(input.domain === 'character' && characterFields.some(([f]) => f === field))
    )
      return { facet, state: 'unsupported', reason: 'unsupported-domain-facet' };
    if (!a || !b || (!a.item && !b.item))
      return { facet, state: 'undetermined', reason: 'unresolved-exact-or-item' };
    if (facet === 'existence')
      return { facet, state: !!a.item === !!b.item ? 'unchanged' : 'changed' };
    if (!a.item || !b.item)
      return { facet, state: 'undetermined', reason: 'target-added-or-removed' };
    if (
      field
        ? a.unresolved.has(field) || b.unresolved.has(field)
        : a.unresolved.size || b.unresolved.size
    )
      return { facet, state: 'undetermined', reason: 'unresolved-character-cell' };
    return {
      facet,
      state:
        canonicalJson(field ? a.fields?.[field] : a.item) ===
        canonicalJson(field ? b.fields?.[field] : b.item)
          ? 'unchanged'
          : 'changed',
    };
  });
  return {
    ...input,
    comparisonRules: 'creative-saved-content/1',
    facets,
    scope: facets.every((f) => f.state === 'changed' || f.state === 'unchanged')
      ? ('complete' as const)
      : ('partial' as const),
    current,
    requestKey: canonicalJson(input),
  };
}
