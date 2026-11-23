import {
  canonicalEqual,
  canonicalJson,
  contentHash,
  createArtifact,
  createArtifactIfAbsent,
  deserializeArtifact,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  prepareLiveReference,
  type LiveReferenceProvider,
} from '@editor-platform/artifact-references';
import {
  sameLocalRevision,
  transaction,
  type EditorCommand,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import {
  hostNativeArtifactByteLimit,
  serializeHostNativeArtifact,
} from '@editor-platform/editor-host';
import { prepareSlideDocument, validateSlideDocument } from '@editor-platform/slide/document';
import { isDeck, slideLiveReference, type SlideContent } from '@editor-platform/slide/model';
import type {
  SlideDocumentOption,
  SlideDocumentPreview,
  SlideDocumentSource,
} from '@editor-platform/slide';
import type { StoredArtifact } from '../model';

const versions = (record: Pick<Artifact<unknown>, 'versions'>): SlideDocumentOption['versions'] =>
  record.versions
    .map((version, index) => ({
      id: version.versionId,
      label: `v${index + 1} ${version.reason ?? ''}`.trim(),
      hash: version.contentHash,
    }))
    .reverse();

export function slideDocuments(records: Iterable<StoredArtifact>) {
  return [...records].flatMap((record) =>
    record.kind === 'document' && record.versions.length
      ? [{ id: record.id, name: record.name, versions: versions(record) }]
      : [],
  );
}

async function readFile(file: File) {
  if (file.size > hostNativeArtifactByteLimit)
    throw new Error(`${file.name}：ネイティブファイルの 64 MiB 上限を超えています。`);
  try {
    const text = await file.text();
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && ('draft' in value || 'kind' in value)) {
      const record = deserializeArtifact(text);
      if (record.kind !== 'document')
        throw new Error('Document のネイティブファイルを選んでください。');
      return { record };
    }
    return { value };
  } catch (error) {
    throw new Error(`${file.name}：${(error as Error).message}`);
  }
}

export async function slideDocumentFileVersions(file: File) {
  const { record } = await readFile(file);
  return record ? versions(record) : [];
}

export interface SlideDocumentAccess {
  readDocument(id: string): StoredArtifact | undefined;
  readTarget(): {
    record: StoredArtifact;
    content: SlideContent;
    revision: LocalDraftRevision;
  };
  assertCanCreate(): void;
  provider: LiveReferenceProvider;
  storage: Pick<StorageAdapter<StoredArtifact>, 'putIfAbsent'>;
  created(record: StoredArtifact): void;
  append(
    command: EditorCommand<SlideContent>,
    firstPage: string,
    beforeWrite: () => void,
  ): Promise<void>;
}

async function readSource(source: SlideDocumentSource, access: SlideDocumentAccess) {
  const file = source.kind === 'file' ? source.file : undefined;
  const input = file ? await readFile(file) : undefined;
  const record =
    input?.record ?? (source.kind === 'saved' ? access.readDocument(source.artifactId) : undefined);
  const label =
    record?.name ?? file?.name ?? (source.kind === 'saved' ? source.artifactId : '文書');
  try {
    if (source.kind === 'saved' && (!record || record.kind !== 'document'))
      throw new Error('読み取り可能な元の文書が見つかりません。');
    const version =
      source.versionId === undefined
        ? undefined
        : record?.versions.find((version) => version.versionId === source.versionId);
    if (source.versionId !== undefined && !version)
      throw new Error('指定された保存版が見つかりません。');
    const content = validateSlideDocument(
      version ? version.content : record ? record.draft.content : input?.value,
    );
    const hash = await contentHash(content);
    if (
      (version && hash !== version.contentHash) ||
      (source.kind === 'saved' && hash !== source.hash)
    )
      throw new Error('保存版の内容が一致しません。選び直してプレビューしてください。');
    const labelVersion =
      version && record
        ? versions(record).find(({ id }) => id === version.versionId)?.label
        : undefined;
    return {
      content,
      hash,
      label: `${label} ／ ${labelVersion ?? (record ? '下書き' : 'ローカル JSON')}`,
    };
  } catch (error) {
    throw new Error(`${label}：${(error as Error).message}`);
  }
}

async function verifyQuotes(
  candidate: ReturnType<typeof prepareSlideDocument>,
  artifactId: string,
  provider: LiveReferenceProvider,
  signal: AbortSignal,
) {
  const figures = new Map<string, string>();
  for (const [index, page] of candidate.pages.entries()) {
    for (const [position, object] of page.objects.entries()) {
      signal.throwIfAborted();
      if (!object.liveQuote) continue;
      const quote = slideLiveReference(candidate.content, object.liveQuote);
      try {
        const { reference, figureSrc } = await prepareLiveReference(
          quote.source,
          quote.snapshot,
          provider,
          quote.presentation.kind === 'value' ? quote.presentation.format : undefined,
          artifactId,
        );
        if (!canonicalEqual(reference, quote))
          throw new Error('固定版と引用の表示が一致しません。');
        if (figureSrc) figures.set(object.id, figureSrc);
      } catch (error) {
        throw new Error(
          `${index + 1} 枚目「${page.title}」の ${position + 1} 件目の引用：${(error as Error).message}`,
        );
      }
    }
  }
  return figures;
}

export async function prepareSlideDocumentImport(
  source: SlideDocumentSource,
  mode: 'new' | 'append',
  name: string,
  signal: AbortSignal,
  access: SlideDocumentAccess,
): Promise<SlideDocumentPreview> {
  const target = mode === 'append' ? access.readTarget() : undefined;
  if (!target) access.assertCanCreate();
  const input = await readSource(source, access);
  let plan: ReturnType<typeof prepareSlideDocument>;
  try {
    plan = prepareSlideDocument(input.content, target?.content);
  } catch (error) {
    throw new Error(`${input.label}：${(error as Error).message}`);
  }
  const created: StoredArtifact | undefined = target
    ? undefined
    : { ...createArtifact('slide', name.trim() || 'Slide Deck', plan.content), annotations: [] };
  function assertDestination() {
    if (!target) {
      access.assertCanCreate();
      return;
    }
    const current = access.readTarget();
    if (
      target.record.id !== current.record.id ||
      target.record.draft.baseVersionId !== current.record.draft.baseVersionId ||
      !sameLocalRevision(target.revision, current.revision)
    )
      throw new Error('追加先のデッキが変わりました。もう一度プレビューしてください。');
    serializeHostNativeArtifact({
      ...current.record,
      draft: { ...current.record.draft, content: plan.content },
    });
  }
  assertDestination();
  if (created) serializeHostNativeArtifact(created);
  const artifactId = target?.record.id ?? created!.id;
  const figures = await verifyQuotes(plan, artifactId, access.provider, signal);
  signal.throwIfAborted();
  assertDestination();
  let committing = false;
  let committed = false;
  return {
    sourceLabel: input.label,
    destinationLabel: target
      ? `末尾に追加 ／ ${target.record.name}`
      : `新しいデッキ ／ ${created!.name} ／ ${plan.content.width} × ${plan.content.height}`,
    firstPage: (target?.content.slides.length ?? 0) + 1,
    pages: plan.pages,
    figures,
    async commit(signal, origin) {
      if (committed) return;
      if (committing) throw new Error('このプレビューを確定しています。');
      committing = true;
      try {
        signal.throwIfAborted();
        assertDestination();
        await verifyQuotes(plan, artifactId, access.provider, signal);
        if ((await readSource(source, access)).hash !== input.hash)
          throw new Error(
            `${input.label}：文書の内容が変わりました。もう一度プレビューしてください。`,
          );
        signal.throwIfAborted();
        assertDestination();
        if (created) {
          const saved = await createArtifactIfAbsent(
            access.storage,
            created,
            canonicalJson(created),
            canonicalJson,
          );
          access.created(saved);
        } else if (plan.append) {
          const cmd = origin
            ? transaction(plan.append.label, [plan.append], {
                origin: 'proposal',
                transactionId: plan.append.context!.transactionId,
                proposalId: origin.proposalId,
              })
            : plan.append;
          await access.append(cmd, plan.pages[0].id, () => {
            signal.throwIfAborted();
            assertDestination();
          });
        }
        committed = true;
      } finally {
        committing = false;
      }
    },
  };
}

/** The Host admits data-only proposals for one conversion from a pinned saved document. */
export function prepareSlideDocumentProposal(
  value: unknown,
  signal: AbortSignal,
  access: SlideDocumentAccess,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('文書変換の提案が不正です。');
  const input = value as Record<string, unknown>;
  const {
    type,
    artifactId,
    versionId,
    contentHash: hash,
    name,
    targetId,
    baseVersionId,
    revision,
  } = input;
  const create = type === 'slide.document.create';
  const allowed = create
    ? ['type', 'artifactId', 'versionId', 'contentHash', 'name']
    : ['type', 'artifactId', 'versionId', 'contentHash', 'targetId', 'baseVersionId', 'revision'];
  if (
    (!create && type !== 'slide.document.append') ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    typeof artifactId !== 'string' ||
    !artifactId ||
    typeof versionId !== 'string' ||
    !versionId ||
    typeof hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    (create && (typeof name !== 'string' || !name.trim() || name.length > 512))
  )
    throw new Error('文書変換の提案には、操作と元の文書の保存版を一件指定してください。');
  if (!create) {
    const target = access.readTarget();
    if (
      target.record.id !== targetId ||
      target.record.draft.baseVersionId !== baseVersionId ||
      !canonicalEqual(target.revision, revision) ||
      !isDeck(target.content)
    )
      throw new Error('提案の追加先または基準の版・下書きが変わりました。');
  }
  return prepareSlideDocumentImport(
    { kind: 'saved', artifactId, versionId, hash },
    create ? 'new' : 'append',
    create ? (name as string) : '',
    signal,
    access,
  );
}
