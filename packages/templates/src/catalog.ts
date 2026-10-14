import { clone, canonicalJson } from '@editor-platform/artifact-core';
import { validateDefinition, sealDefinition } from './engine';
import { assertTemplateTextSize, templateLimits } from './limits';
import {
  refKey,
  lockClosure,
  stableId,
  validateRef,
  reuseHash,
  type DefinitionRef,
  type ReusableDefinition,
} from '@editor-platform/reuse-core';
import { validateReusableClosure } from './reuse-catalog';
import { compositionBundle } from './reuse-composition';
import {
  problem,
  TemplateError,
  type CatalogAdapter,
  type CatalogQuery,
  type TemplateDefinition,
  type CatalogBundle,
  type ReusableQuery,
  type ReusableDraft,
} from './types';
const reusableId = (d: Pick<DefinitionRef, 'libraryId' | 'definitionId'>) =>
  JSON.stringify([d.libraryId, d.definitionId]);
function filterReusable(
  values: ReusableDefinition<unknown>[],
  query: ReusableQuery = {},
  archived = new Set<string>(),
) {
  const latest = new Map<string, ReusableDefinition<unknown>>();
  for (const d of values) {
    if (
      (!query.archived && archived.has(reusableId(d))) ||
      (query.domain && d.domain !== query.domain) ||
      (query.kind && d.kind !== query.kind) ||
      (query.search && !d.name.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))
    )
      continue;
    const id = reusableId(d),
      old = latest.get(id);
    if (old?.version === d.version && old.hash !== d.hash)
      problem('version-conflict', 'Catalog adapters disagree about reusable version');
    if (!old || old.version < d.version) latest.set(id, d);
  }
  return clone([...latest.values()]);
}
async function validateBundle(bundle: CatalogBundle) {
  if (
    bundle.publishDraft &&
    (!stableId(bundle.publishDraft.id) ||
      !Number.isInteger(bundle.publishDraft.revision) ||
      bundle.publishDraft.revision < 1)
  )
    problem('draft-schema', 'Invalid publication request identity');
  const templates = await Promise.all(bundle.templates.map(validateDefinition));
  const compositions = await Promise.all(
    templates.filter((t) => t.composition).map(compositionBundle),
  );
  const closures = await Promise.all(
    [...bundle.reusable, ...compositions.map((c) => c.closure)].map(validateReusableClosure),
  );
  const reusable = new Map<string, ReusableDefinition<unknown>>();
  for (const d of closures.flatMap((c) => c.definitions)) {
    const key = refKey(d),
      old = reusable.get(key);
    if (old && old.hash !== d.hash)
      problem('version-conflict', 'Conflicting reusable versions in pack');
    reusable.set(key, d);
  }
  if (templates.length + reusable.size > templateLimits.definitions)
    problem('template-limit', 'Too many published definitions');
  return { templates, reusable: [...reusable.values()] };
}
const publicationKey = (draft: NonNullable<CatalogBundle['publishDraft']>) =>
  'receipt:reuse:' + JSON.stringify([draft.id, draft.revision]);
const publicationHash = (bundle: CatalogBundle) =>
  reuseHash({
    templates: bundle.templates.map((d) => [d.templateId, d.templateVersion, d.hash]).sort(),
    reusable: bundle.reusable.map((c) => c.hash).sort(),
  });
function checkDraftRevision(draft: ReusableDraft, expected: number | null) {
  if (
    !stableId(draft.id) ||
    !Number.isInteger(draft.revision) ||
    draft.revision !== (expected ?? 0) + 1
  )
    problem('draft-schema', 'Draft revision must increment exactly once');
  validateRef(draft.ref);
  if (draft.base) {
    validateRef(draft.base);
    if (
      draft.base.libraryId !== draft.ref.libraryId ||
      draft.base.definitionId !== draft.ref.definitionId ||
      draft.base.version >= draft.ref.version
    )
      problem('draft-base', 'A new version must follow the same definition identity');
  }
  if (
    !draft.closure.roots.some((r) => refKey(r) === refKey(draft.ref) && r.hash === draft.ref.hash)
  )
    problem('draft-root', 'Draft must retain its exact root');
}
function checkPublishedDraft(bundle: CatalogBundle, draft?: ReusableDraft) {
  if (!bundle.publishDraft) return;
  if (!draft || draft.revision !== bundle.publishDraft.revision)
    problem('draft-conflict', 'The mutable draft changed; reload before publishing');
  if (!bundle.reusable.some((c) => c.hash === draft.closure.hash))
    problem('draft-conflict', 'The publication differs from the reviewed draft');
}
export function filterCatalog(values: TemplateDefinition[], query: CatalogQuery = {}) {
  return values.filter(
    (d) =>
      (!query.domain || d.domain === query.domain) &&
      (!query.kind || d.kind === query.kind) &&
      (!query.category || d.category === query.category) &&
      (!query.locale || d.locales.includes(query.locale)) &&
      (!query.capabilities || d.capabilities.every((c) => query.capabilities!.includes(c))) &&
      (!query.search ||
        `${d.name} ${d.description} ${d.purpose} ${d.tags.join(' ')}`
          .toLocaleLowerCase()
          .includes(query.search.toLocaleLowerCase())),
  );
}
export class MemoryCatalog implements CatalogAdapter {
  protected versions = new Map<string, TemplateDefinition>();
  protected archived = new Set<string>();
  protected reusable = new Map<string, ReusableDefinition<unknown>>();
  protected reusableArchived = new Set<string>();
  protected reusableDrafts = new Map<string, ReusableDraft>();
  protected publicationReceipts = new Map<string, string>();
  constructor(definitions: TemplateDefinition[] = []) {
    for (const d of definitions)
      this.versions.set(`${d.templateId}@${d.templateVersion}`, clone(d));
  }
  async list(query: CatalogQuery = {}) {
    const latest = new Map<string, TemplateDefinition>();
    for (const d of this.versions.values())
      if (
        (query.archived || !this.archived.has(d.templateId)) &&
        (!latest.has(d.templateId) || latest.get(d.templateId)!.templateVersion < d.templateVersion)
      )
        latest.set(d.templateId, d);
    return clone(filterCatalog([...latest.values()], query));
  }
  async getVersion(id: string, version: number) {
    return clone(this.versions.get(`${id}@${version}`));
  }
  async put(value: TemplateDefinition) {
    await this.putMany([value]);
  }
  async putMany(values: TemplateDefinition[]) {
    return this.putBundle({ templates: values, reusable: [] });
  }
  async putBundle(bundle: CatalogBundle) {
    bundle = clone(bundle);
    const verified = await validateBundle(bundle);
    if (bundle.publishDraft) {
      const old = this.publicationReceipts.get(publicationKey(bundle.publishDraft));
      if (old) {
        if (old !== publicationHash(bundle))
          problem(
            'publication-conflict',
            'Publication request was already used with different content',
          );
        return;
      }
    }
    checkPublishedDraft(
      bundle,
      bundle.publishDraft ? this.reusableDrafts.get(bundle.publishDraft.id) : undefined,
    );
    const next = new Map(this.versions);
    const nextReuse = new Map(this.reusable);
    for (const d of verified.templates) {
      const key = `${d.templateId}@${d.templateVersion}`,
        old = next.get(key);
      if (old && canonicalJson(old) !== canonicalJson(d))
        problem('version-conflict', `Immutable version already exists: ${key}`);
      next.set(key, d);
    }
    for (const d of verified.reusable) {
      const key = refKey(d),
        old = nextReuse.get(key);
      if (old && old.hash !== d.hash)
        problem('version-conflict', 'Immutable reusable version already exists');
      nextReuse.set(key, d);
    }
    this.versions = next;
    this.reusable = nextReuse;
    if (bundle.publishDraft) {
      this.reusableDrafts.delete(bundle.publishDraft.id);
      this.publicationReceipts.set(publicationKey(bundle.publishDraft), publicationHash(bundle));
    }
  }
  async listReusableDrafts() {
    return clone([...this.reusableDrafts.values()]);
  }
  async saveReusableDraft(draft: ReusableDraft, expectedRevision: number | null) {
    draft = clone(draft);
    checkDraftRevision(draft, expectedRevision);
    await validateReusableClosure(draft.closure);
    if ((this.reusableDrafts.get(draft.id)?.revision ?? null) !== expectedRevision)
      problem('draft-conflict', 'The mutable draft changed; reload before saving');
    this.reusableDrafts.set(draft.id, clone(draft));
  }
  async deleteReusableDraft(id: string, expectedRevision: number) {
    if (this.reusableDrafts.get(id)?.revision !== expectedRevision)
      problem('draft-conflict', 'The mutable draft changed');
    this.reusableDrafts.delete(id);
  }
  async listReusable(query: ReusableQuery = {}) {
    return filterReusable([...this.reusable.values()], query, this.reusableArchived);
  }
  async getReusable(ref: DefinitionRef) {
    const value = this.reusable.get(refKey(ref));
    if (
      value &&
      (value.hash !== ref.hash || value.kind !== ref.kind || value.domain !== ref.domain)
    )
      problem('version-conflict', 'Exact reusable reference differs');
    return clone(value);
  }
  async archiveReusable(libraryId: string, definitionId: string, archived: boolean) {
    const key = reusableId({ libraryId, definitionId });
    if (archived) this.reusableArchived.add(key);
    else this.reusableArchived.delete(key);
  }
  async archive(id: string, archived: boolean) {
    if (archived) this.archived.add(id);
    else this.archived.delete(id);
  }
}
/** Local persistence uses one transaction for conflict checking and all pack writes. */
export class LocalCatalog implements CatalogAdapter {
  private db: Promise<IDBDatabase>;
  constructor(name = 'editor-platform-templates') {
    this.db = new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('versions', { keyPath: 'key' });
        r.result.createObjectStore('archive');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  private async all() {
    const db = await this.db;
    return new Promise<
      {
        definition?: TemplateDefinition;
        reusable?: ReusableDefinition<unknown>;
        draft?: ReusableDraft;
      }[]
    >((resolve, reject) => {
      const tx = db.transaction('versions'),
        r = tx.objectStore('versions').getAll();
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  async list(query: CatalogQuery = {}) {
    const memory = new MemoryCatalog(
      (await this.all()).flatMap((r) => (r.definition ? [r.definition] : [])),
    );
    const db = await this.db;
    const archived = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction('archive'),
        r = tx.objectStore('archive').getAllKeys();
      tx.oncomplete = () => resolve(r.result.map(String));
      tx.onerror = () => reject(tx.error);
    });
    for (const id of archived) await memory.archive(id, true);
    return memory.list(query);
  }
  async getVersion(id: string, version: number) {
    const db = await this.db;
    return new Promise<TemplateDefinition | undefined>((resolve, reject) => {
      const tx = db.transaction('versions'),
        r = tx.objectStore('versions').get(`${id}@${version}`);
      tx.oncomplete = () => resolve(r.result?.definition);
      tx.onerror = () => reject(tx.error);
    });
  }
  async put(value: TemplateDefinition) {
    await this.putMany([value]);
  }
  async putMany(values: TemplateDefinition[]) {
    return this.putBundle({ templates: values, reusable: [] });
  }
  async putBundle(bundle: CatalogBundle) {
    bundle = clone(bundle);
    const verified = await validateBundle(bundle);
    const duplicates = new Map<string, string>();
    for (const d of verified.templates) {
      const key = `${d.templateId}@${d.templateVersion}`;
      if (duplicates.has(key) && duplicates.get(key) !== d.hash)
        problem('version-conflict', 'Conflicting versions in pack');
      duplicates.set(key, d.hash);
    }
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('versions', 'readwrite'),
        store = tx.objectStore('versions');
      let failure: Error | undefined;
      if (bundle.publishDraft) {
        const key = 'draft:reuse:' + bundle.publishDraft.id,
          receiptKey = publicationKey(bundle.publishDraft),
          hash = publicationHash(bundle),
          receipt = store.get(receiptKey);
        receipt.onsuccess = () => {
          if (receipt.result) {
            if (receipt.result.hash !== hash) {
              failure = new TemplateError(
                'publication-conflict',
                'Publication request was already used with different content',
              );
              tx.abort();
            }
            return;
          }
          const r = store.get(key);
          r.onsuccess = () => {
            try {
              checkPublishedDraft(bundle, r.result?.draft);
              store.delete(key);
              store.put({ key: receiptKey, hash });
            } catch (error) {
              failure = error as Error;
              tx.abort();
            }
          };
        };
      }
      const records = [
        ...verified.templates.map((definition) => ({
          key: `${definition.templateId}@${definition.templateVersion}`,
          definition,
        })),
        ...verified.reusable.map((reusable) => ({ key: 'reuse:' + refKey(reusable), reusable })),
      ];
      for (const record of records) {
        const key = record.key,
          r = store.get(key);
        r.onsuccess = () => {
          if (r.result && canonicalJson(r.result) !== canonicalJson(record)) {
            failure = new TemplateError(
              'version-conflict',
              `Immutable version already exists: ${key}`,
            );
            tx.abort();
          } else store.put(record);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error);
      tx.onerror = () => reject(failure ?? tx.error);
    });
  }
  async listReusableDrafts() {
    return (await this.all()).flatMap((r) => (r.draft ? [r.draft] : []));
  }
  async saveReusableDraft(draft: ReusableDraft, expectedRevision: number | null) {
    draft = clone(draft);
    checkDraftRevision(draft, expectedRevision);
    await validateReusableClosure(draft.closure);
    await this.writeDraft(draft.id, expectedRevision, draft);
  }
  async deleteReusableDraft(id: string, expectedRevision: number) {
    await this.writeDraft(id, expectedRevision);
  }
  private async writeDraft(id: string, expectedRevision: number | null, draft?: ReusableDraft) {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('versions', 'readwrite'),
        store = tx.objectStore('versions'),
        key = 'draft:reuse:' + id,
        r = store.get(key);
      let failure: Error | undefined;
      r.onsuccess = () => {
        if ((r.result?.draft?.revision ?? null) !== expectedRevision) {
          failure = new TemplateError(
            'draft-conflict',
            'The mutable draft changed; reload before saving',
          );
          tx.abort();
        } else if (draft) store.put({ key, draft: clone(draft) });
        else store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error);
    });
  }
  async listReusable(query: ReusableQuery = {}) {
    const db = await this.db;
    const archived = await new Promise<Set<string>>((resolve, reject) => {
      const tx = db.transaction('archive'),
        r = tx.objectStore('archive').getAllKeys();
      tx.oncomplete = () =>
        resolve(
          new Set(
            r.result
              .map(String)
              .filter((k) => k.startsWith('reuse:'))
              .map((k) => k.slice(6)),
          ),
        );
      tx.onerror = () => reject(tx.error);
    });
    return filterReusable(
      (await this.all()).flatMap((r) => (r.reusable ? [r.reusable] : [])),
      query,
      archived,
    );
  }
  async getReusable(ref: DefinitionRef) {
    const db = await this.db;
    const value = await new Promise<ReusableDefinition<unknown> | undefined>((resolve, reject) => {
      const tx = db.transaction('versions'),
        r = tx.objectStore('versions').get('reuse:' + refKey(ref));
      tx.oncomplete = () => resolve(r.result?.reusable);
      tx.onerror = () => reject(tx.error);
    });
    if (
      value &&
      (value.hash !== ref.hash || value.kind !== ref.kind || value.domain !== ref.domain)
    )
      problem('version-conflict', 'Exact reusable reference differs');
    return value;
  }
  async archiveReusable(libraryId: string, definitionId: string, archived: boolean) {
    return this.archive('reuse:' + reusableId({ libraryId, definitionId }), archived);
  }
  async archive(id: string, archived: boolean) {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('archive', 'readwrite');
      if (archived) tx.objectStore('archive').put(true, id);
      else tx.objectStore('archive').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async close() {
    (await this.db).close();
  }
}
export class TemplateCatalog {
  constructor(readonly adapters: CatalogAdapter[]) {}
  async list(query: CatalogQuery = {}) {
    const all = (await Promise.all(this.adapters.map((a) => a.list(query)))).flat();
    const latest = new Map<string, TemplateDefinition>();
    for (const d of all) {
      const old = latest.get(d.templateId);
      if (old?.templateVersion === d.templateVersion && old.hash !== d.hash)
        problem('version-conflict', 'Catalog adapters disagree about an immutable version');
      if (!old || old.templateVersion < d.templateVersion) latest.set(d.templateId, d);
    }
    return [...latest.values()];
  }
  async getVersion(id: string, version: number) {
    const all = (await Promise.all(this.adapters.map((a) => a.getVersion(id, version)))).filter(
      (d): d is TemplateDefinition => !!d,
    );
    if (new Set(all.map((d) => d.hash)).size > 1)
      problem('version-conflict', 'Catalog adapters disagree');
    if (!all[0]) problem('template-missing', 'Template version is unavailable');
    return validateDefinition(all[0]);
  }
  async describe(id: string, version: number) {
    return this.getVersion(id, version);
  }
  async listReusable(query: ReusableQuery = {}) {
    return filterReusable(
      (await Promise.all(this.adapters.map((a) => a.listReusable?.(query) ?? []))).flat(),
      query,
    );
  }
  async getReusable(ref: DefinitionRef) {
    const all = (await Promise.all(this.adapters.map((a) => a.getReusable?.(ref)))).filter(
      (d): d is ReusableDefinition<unknown> => !!d,
    );
    if (!all.length) problem('template-missing', 'Exact reusable definition is unavailable');
    if (new Set(all.map((d) => d.hash)).size > 1)
      problem('version-conflict', 'Catalog adapters disagree');
    return all[0];
  }
  async closure(ref: DefinitionRef) {
    const found = new Map<string, ReusableDefinition<unknown>>(),
      active = new Set<string>();
    const visit = async (r: DefinitionRef, depth: number) => {
      if (depth > 16 || found.size >= 100) problem('template-limit', 'Reusable dependency limit');
      const key = refKey(r);
      if (active.has(key)) problem('dependency-cycle', 'Cyclic reusable catalog dependency');
      if (found.has(key)) return;
      active.add(key);
      const d = await this.getReusable(r);
      found.set(key, d);
      for (const child of d.dependencies) await visit(child, depth + 1);
      active.delete(key);
    };
    await visit(ref, 0);
    return lockClosure<unknown>([ref], [...found.values()]);
  }
}
export async function exportTemplatePack(
  definitions: TemplateDefinition[],
  reusable: CatalogBundle['reusable'] = [],
) {
  reusable = clone(reusable);
  if (definitions.length > templateLimits.definitions)
    problem('template-limit', 'Too many definitions');
  const valid = await Promise.all(definitions.map(validateDefinition));
  for (const template of valid.filter((t) => t.composition)) {
    const { closure } = await compositionBundle(template);
    if (!reusable.some((c) => c.hash === closure.hash)) reusable.push(closure);
  }
  await validateBundle({ templates: valid, reusable });
  const text = JSON.stringify(
    {
      format: 'editor-template-pack',
      schemaVersion: 1,
      definitions: valid,
      ...(reusable.length ? { reusable } : {}),
    },
    null,
    2,
  );
  assertTemplateTextSize(text, templateLimits.packBytes);
  return text;
}
export async function importTemplatePack(text: string, target: CatalogAdapter) {
  assertTemplateTextSize(text, templateLimits.packBytes);
  let pack: unknown;
  try {
    pack = JSON.parse(text);
  } catch {
    problem('pack-schema', 'Invalid JSON pack');
  }
  const p = pack as {
    format?: string;
    schemaVersion?: number;
    definitions?: unknown[];
    reusable?: CatalogBundle['reusable'];
  };
  if (
    !p ||
    p.format !== 'editor-template-pack' ||
    p.schemaVersion !== 1 ||
    !Array.isArray(p.definitions) ||
    p.definitions.length > templateLimits.definitions ||
    (p.reusable !== undefined &&
      (!Array.isArray(p.reusable) || p.reusable.length > templateLimits.definitions))
  )
    problem('pack-schema', 'Unsupported template pack');
  const definitions = await Promise.all(p.definitions.map(validateDefinition));
  if (p.reusable?.length) {
    if (!target.putBundle)
      problem('catalog-capability', 'Catalog must support atomic reusable pack import');
    await target.putBundle({ templates: definitions, reusable: p.reusable });
    return definitions;
  }
  if (!target.putMany) problem('catalog-capability', 'Catalog must support atomic pack import');
  await target.putMany(definitions);
  return definitions;
}
export async function createTemplateVersion(
  old: TemplateDefinition,
  changes: Partial<
    Pick<
      TemplateDefinition,
      | 'name'
      | 'description'
      | 'purpose'
      | 'category'
      | 'content'
      | 'inputs'
      | 'bindings'
      | 'repeats'
      | 'sample'
      | 'assets'
    >
  >,
) {
  const { hash: _, ...definition } = old;
  void _;
  const next = await sealDefinition({
    ...definition,
    ...clone(changes),
    templateVersion: old.templateVersion + 1,
  });
  return validateDefinition(next);
}
