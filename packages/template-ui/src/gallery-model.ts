import { clone } from '@editor-platform/artifact-core';
import {
  applySharedTemplate,
  expandTemplate,
  localTemplateSnapshot,
  prepareInsertion,
  prepareInstantiation,
  preparePreset,
  prepareViewPreset,
  previewSharedTemplate,
  type InputValue,
  type NativeContent,
  type PreparedApplication,
  type PreparedCreation,
  type StructureLayout,
  type TemplateDefinition,
  type TemplateKind,
  type TemplateTarget,
} from '@editor-platform/templates';
import type { TemplateGalleryProps } from './gallery';

export type GalleryPrepared =
  | { creation: PreparedCreation; content: NativeContent }
  | { application: PreparedApplication; content: NativeContent; token?: string }
  | { settings: Record<string, InputValue>; content?: undefined };

export function recent() {
  try {
    return JSON.parse(localStorage.getItem('ep-template-recent') ?? '[]') as string[];
  } catch {
    return [];
  }
}
export function remember(id: string) {
  try {
    localStorage.setItem(
      'ep-template-recent',
      JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 12)),
    );
  } catch {
    /* optional preference */
  }
}
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function unitLabel(d: TemplateDefinition) {
  if (d.kind === 'whole') return '全体セット';
  if (d.kind === 'preset')
    return ['review', 'file'].includes(d.domain) ? '表示・注釈作成の設定' : '選択範囲のスタイル';
  return (
    d.structure?.unit ??
    {
      slide: 'ページ・ページ内の部品',
      whiteboard: 'セクション・図解',
      design: 'フレーム・部品群',
      document: '本文・表・注意書き',
      data: '列・ビュー',
      review: '表示設定',
      file: '表示設定',
    }[d.domain]
  );
}

export function insertionPosition(content: NativeContent) {
  const items =
    'nodes' in content
      ? [...content.nodes, ...(content.sections ?? [])]
      : 'elements' in content
        ? content.elements
        : [];
  return {
    x: items.length ? Math.max(...items.map((e) => e.bounds.x + e.bounds.width)) + 80 : 0,
    y: 0,
  };
}

export function galleryTitle(kind: TemplateKind) {
  return kind === 'whole'
    ? 'テンプレートから作成'
    : kind === 'fragment'
      ? '部分テンプレートを挿入'
      : 'スタイル・表示プリセット';
}

/** Gives every repeated structure item a stable item id before it is stored. */
export function withStructureItemIds(
  selected: TemplateDefinition | undefined,
  next: Record<string, InputValue>,
) {
  if (selected?.structure) {
    const slot = selected.repeats[selected.structure.repeat].slot;
    const items = next[slot];
    if (Array.isArray(items))
      next = {
        ...next,
        [slot]: items.map((item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          !Object.hasOwn(item, selected.structure!.itemId)
            ? { ...item, [selected.structure!.itemId]: `i-${crypto.randomUUID()}` }
            : item,
        ),
      };
  }
  return next;
}

/** Resizes the repeated structure to `count` items, filling new items from the sample. */
export function variedInputs(
  selected: TemplateDefinition & { structure: NonNullable<TemplateDefinition['structure']> },
  values: Record<string, InputValue>,
  count: number,
  layout?: StructureLayout,
) {
  const slot = selected.repeats[selected.structure.repeat].slot,
    old = values[slot] as Record<string, InputValue>[];
  const sample = selected.sample[slot] as Record<string, InputValue>[];
  return {
    ...values,
    [slot]: Array.from(
      { length: count },
      (_, i) =>
        old[i] ?? {
          ...clone(sample[i % sample.length]),
          id: `item-${i + 1}`,
          ...(typeof sample[i % sample.length].title === 'string'
            ? {
                title: `${String(sample[i % sample.length].title).replace(/\s+\d+$/, '')} ${i + 1}`,
              }
            : {}),
        },
    ),
    [selected.structure.layoutSlot]: layout ?? values[selected.structure.layoutSlot],
  };
}

export function mappingContentFor(
  selected: TemplateDefinition | undefined,
  values: Record<string, InputValue>,
) {
  let mappingContent = selected?.content;
  if (selected?.structure && selected.domain === 'data') {
    try {
      mappingContent = expandTemplate(selected, values, { remap: false }).content;
    } catch {
      /* input diagnostics appear on preparation */
    }
  }
  return mappingContent;
}

type GalleryTarget = TemplateGalleryProps['target'];

async function prepareTargetPreview(options: {
  selected: TemplateDefinition;
  input: Record<string, InputValue>;
  kind: TemplateKind;
  target: NonNullable<GalleryTarget>;
  scope: 'selection' | 'artifact';
  mapping: TemplateTarget['fieldMapping'];
}): Promise<GalleryPrepared> {
  const { selected, input, kind, target } = options;
  const state =
      target.shared?.confirmed ??
      localTemplateSnapshot(target.artifactId, target.domain, target.content),
    identity = target.shared?.adapter.identity ?? {
      actorId: 'local',
      clientId: 'local',
      sessionId: 'local',
    };
  const targetOptions: TemplateTarget = {
    ids: target.ids,
    scope: options.scope,
    afterId: target.afterId,
    fieldMapping: options.mapping,
    position: ['whiteboard', 'design'].includes(target.domain)
      ? insertionPosition(target.content)
      : undefined,
  };
  const application = await (kind === 'fragment' ? prepareInsertion : preparePreset)(
    selected,
    input,
    state,
    identity,
    targetOptions,
  );
  const sharedPreview = target.shared
    ? await previewSharedTemplate(application, target.shared)
    : undefined;
  return {
    application,
    content: sharedPreview?.after ?? application.preview,
    token: sharedPreview?.token,
  };
}

/** Prepares the creation, insertion/preset application or view settings for one template. */
export async function prepareGalleryPreview(options: {
  selected: TemplateDefinition;
  input: Record<string, InputValue>;
  kind: TemplateKind;
  readOnly?: boolean;
  target: GalleryTarget;
  sampleRows: boolean;
  scope: 'selection' | 'artifact';
  mapping: TemplateTarget['fieldMapping'];
}): Promise<GalleryPrepared> {
  const { selected, input, kind, target } = options;
  if (kind === 'whole') {
    if (options.readOnly) throw new Error('Read only');
    const creation = await prepareInstantiation(selected, input, crypto.randomUUID(), {
      includeSampleRows: options.sampleRows,
    });
    return { creation, content: creation.artifact.draft.content };
  }
  if (!target) throw new Error('Open a compatible artifact first');
  if (['review', 'file'].includes(target.domain))
    return { settings: await prepareViewPreset(selected, input) };
  if (options.readOnly) throw new Error('Read only');
  return prepareTargetPreview({ ...options, target });
}

/** Hands a prepared template result to the matching Host callback. */
export async function applyGalleryPrepared(
  prepared: GalleryPrepared,
  selected: TemplateDefinition,
  props: Pick<
    TemplateGalleryProps,
    'readOnly' | 'target' | 'onCreate' | 'onApply' | 'onViewSettings'
  >,
) {
  if (props.readOnly && !('settings' in prepared)) throw new Error('Read only');
  if ('creation' in prepared) {
    if (!props.onCreate) throw new Error('This Host does not allow creation');
    await props.onCreate(prepared.creation);
  } else if ('application' in prepared) {
    if (props.target?.shared) {
      await applySharedTemplate(prepared.application, props.target.shared, prepared.token!);
      await props.onApply?.(prepared.application);
    } else {
      if (!props.onApply) throw new Error('This Host does not allow insertion');
      await props.onApply(prepared.application);
    }
  } else props.onViewSettings?.(selected.domain, prepared.settings);
}

export function fieldMappingColumns(
  kind: TemplateKind,
  selected: TemplateDefinition,
  target: TemplateGalleryProps['target'],
  mappingContent: NativeContent | undefined,
) {
  return kind === 'fragment' &&
    selected.domain === 'data' &&
    target &&
    'columns' in target.content &&
    mappingContent &&
    'columns' in mappingContent
    ? {
        columns: mappingContent.columns,
        targetColumns: 'columns' in target.content ? target.content.columns : [],
      }
    : undefined;
}
