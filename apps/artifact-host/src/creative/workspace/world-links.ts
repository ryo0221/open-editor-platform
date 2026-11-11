import { clone, canonicalJson } from '@editor-platform/artifact-core';

export const worldRoles = [
  'facts',
  'identity',
  'style',
  'sample',
  'scene-state',
  'instructions',
  'exception',
] as const;
export type WorldRole = (typeof worldRoles)[number];
/** CW1 subset: explicit root blocks, or a root Frame. No name/JSONPath/latest resolver. */
export type WorldSelector =
  | { type: 'document-blocks'; blockIds: string[] }
  | { type: 'design-frame'; frameId: string };
export interface WorldReference {
  id: string;
  role: WorldRole;
  namespace: string;
  artifactId: string;
  versionId: string;
  contentHash: string;
  selector: WorldSelector;
  required: boolean;
}
export interface WorldContext {
  id: string;
  revision: number;
  references: WorldReference[];
}
/** Owned only by CreativeWorkspaceLinks. All values are references, never native bodies. */
export interface WorldContexts {
  namespace: string;
  contexts: WorldContext[];
}
const object = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => keys.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096;
export function readWorldContexts(raw: unknown): WorldContexts {
  if (
    !object(raw, ['namespace', 'contexts']) ||
    !id(raw.namespace) ||
    !Array.isArray(raw.contexts) ||
    raw.contexts.length > 64
  )
    throw Error('作品設定の構造が不正です。');
  let count = 0;
  const contextIds = new Set();
  for (const c of raw.contexts) {
    if (
      !object(c, ['id', 'revision', 'references']) ||
      !id(c.id) ||
      contextIds.has(c.id) ||
      !Number.isSafeInteger(c.revision) ||
      (c.revision as number) < 0 ||
      !Array.isArray(c.references)
    )
      throw Error('採用前提の構造が不正です。');
    contextIds.add(c.id);
    count += c.references.length;
    const ids = new Set(),
      targets = new Set();
    for (const r of c.references) {
      if (
        !object(r, [
          'id',
          'role',
          'namespace',
          'artifactId',
          'versionId',
          'contentHash',
          'selector',
          'required',
        ]) ||
        !id(r.id) ||
        ids.has(r.id) ||
        !worldRoles.includes(r.role as WorldRole) ||
        r.namespace !== raw.namespace ||
        !id(r.artifactId) ||
        !id(r.versionId) ||
        typeof r.contentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(r.contentHash) ||
        typeof r.required !== 'boolean'
      )
        throw Error('資料参照が不正・重複、またはnamespaceが異なります。');
      ids.add(r.id);
      const s = r.selector;
      const document =
        object(s, ['type', 'blockIds']) &&
        s.type === 'document-blocks' &&
        Array.isArray(s.blockIds) &&
        s.blockIds.length > 0 &&
        s.blockIds.length <= 256 &&
        s.blockIds.every(id) &&
        new Set(s.blockIds).size === s.blockIds.length;
      const design = object(s, ['type', 'frameId']) && s.type === 'design-frame' && id(s.frameId);
      if ((!document && !design) || (r.role === 'sample' ? !design : !document))
        throw Error('未知selectorまたはrole/domain不一致です。');
      const key = canonicalJson([r.role, r.artifactId, r.selector]);
      if (targets.has(key)) throw Error('同じ資料の参照が重複しています。');
      targets.add(key);
    }
  }
  if (count > 64) throw Error('作品設定の参照上限は64件です。変更しません。');
  return clone(raw) as unknown as WorldContexts;
}
