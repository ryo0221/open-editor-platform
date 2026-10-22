import { isDeck } from '@editor-platform/slide/model';
import {
  definitionRef,
  resolveComponentProperties,
  type ComponentContract,
  type JsonValue,
  type LockedClosure,
  type ReuseInstance,
} from '@editor-platform/reuse-core';
import {
  componentTokenModes,
  exportTemplatePack,
  localTemplateSnapshot,
  prepareComponentInsertion,
  prepareComponentSettings,
  prepareComponentSlot,
  previewArtifactMode,
  retainedComponent,
  reusablePartRich,
  reusableParts,
  type ComponentDefinition,
  type ComponentSlotValue,
  type InputField,
  type InputValue,
  type NativeContent,
  type TemplateCatalog,
  type TemplateTarget,
} from '@editor-platform/templates';
import type { TemplateGalleryProps } from './gallery';

export type LibraryTarget = NonNullable<TemplateGalleryProps['target']>;
export type LibraryBasis = ReturnType<typeof libraryBasis>;

const localIdentity = { actorId: 'local', clientId: 'local', sessionId: 'local' };

export function componentFields(contract: ComponentContract): InputField[] {
  return contract.properties.map((p) => ({
    key: p.id,
    label: p.label,
    description: '',
    type: p.type,
    required: p.required,
    default: p.default,
    min: p.min,
    max: p.max,
    maxLength: p.maxLength,
    options: p.options,
  }));
}

export function initialSlidePageId(target: LibraryTarget) {
  return isDeck(target.content)
    ? (target.content.slides.find(
        (p) => target.ids?.includes(p.id) || p.objects.some((o) => target.ids?.includes(o.id)),
      )?.id ??
        target.content.slides[0]?.id ??
        '')
    : '';
}

export function linkedInstances(content: NativeContent) {
  return 'reuse' in content
    ? (content.reuse?.instances.filter((i) => i.ref.libraryId !== 'native-template-layouts') ?? [])
    : [];
}

export function libraryBasis(target: LibraryTarget) {
  if (target.shared?.pendingCount) throw new Error('入力の同期完了後にプレビューしてください。');
  return {
    state:
      target.shared?.confirmed ??
      localTemplateSnapshot(target.artifactId, target.domain, target.content),
    identity: target.shared?.adapter.identity ?? localIdentity,
  };
}

export function showsArtifactModes(content: NativeContent, instances: ReuseInstance[]) {
  return (
    ('reuse' in content && !!content.reuse?.artifactMode) ||
    instances.some((i) => retainedComponent(content, i.id).definition.payload.styles?.length)
  );
}

export function artifactModeOptions(content: NativeContent, instances: ReuseInstance[]) {
  return [
    ...new Set([
      ...('reuse' in content && content.reuse?.artifactMode ? [content.reuse.artifactMode] : []),
      ...instances.flatMap((i) => {
        const retained = retainedComponent(content, i.id);
        return componentTokenModes(retained.definition, retained.closure);
      }),
    ]),
  ];
}

export async function prepareArtifactModeChange(basis: LibraryBasis, mode: string) {
  const diff = await previewArtifactMode({ ...basis, mode: mode || null });
  if (!diff.prepared) throw new Error(diff.conflicts.map((c) => c.message).join('\n'));
  return diff.prepared;
}

/** Projects current native part text onto untouched text inputs of a linked instance. */
export function componentInputValues(options: {
  selected?: ComponentDefinition;
  instance?: ReuseInstance;
  inputs: Record<string, JsonValue>;
  variant: string;
  changed: string[];
  content: NativeContent;
}): Record<string, InputValue> {
  const { selected, instance, inputs, variant, changed } = options;
  let values: Record<string, InputValue> = inputs;
  if (selected)
    try {
      values = resolveComponentProperties(
        selected.payload.contract,
        inputs,
        variant || undefined,
      ).values;
    } catch {
      /* preview reports schema diagnostics */
    }
  if (instance && selected) {
    values = { ...values };
    const native = reusableParts(options.content);
    for (const property of selected.payload.contract.properties) {
      if (changed.includes(property.id) || !['text', 'rich-text'].includes(property.type)) continue;
      const target = property.targets[0],
        part = native.get(instance.parts[target.partId]);
      if (!part) continue;
      if (target.field === 'text') values[property.id] = String(part.text ?? '');
      if (target.field === 'rich') values[property.id] = reusablePartRich(part);
    }
  }
  return values;
}

export function prepareInstanceSettings(options: {
  base: LibraryBasis;
  instance: ReuseInstance;
  inputs: Record<string, JsonValue>;
  changed: string[];
  variant: string;
  variantChanged: boolean;
  mode: string;
  modeChanged: boolean;
}) {
  const { base, instance, inputs, changed, variant, mode } = options;
  return prepareComponentSettings({
    ...base,
    instanceId: instance.id,
    inputs: Object.fromEntries(changed.map((key) => [key, inputs[key]])),
    ...(options.variantChanged ? { variant: variant || null } : {}),
    ...(options.modeChanged ? { mode: mode || null } : {}),
  });
}

export async function prepareLibraryInsertion(options: {
  base: LibraryBasis;
  catalog: TemplateCatalog;
  target: LibraryTarget;
  selected: ComponentDefinition;
  closure?: LockedClosure<unknown>;
  inputs: Record<string, JsonValue>;
  slots: Record<string, ComponentSlotValue[]>;
  variant: string;
  variantChanged: boolean;
  mode: string;
  reuse: 'linked' | 'copy';
  dataTarget: TemplateTarget;
  slidePageId: string;
}) {
  const { base, catalog, target, selected, variant, mode } = options;
  return prepareComponentInsertion({
    ...base,
    definition: selected,
    closure: options.closure ?? (await catalog.closure(definitionRef(selected))),
    inputs: options.inputs,
    slots: options.slots,
    variant: options.variantChanged ? variant || undefined : undefined,
    mode: mode || undefined,
    reuse: options.reuse,
    target: {
      ...options.dataTarget,
      afterId: target.afterId,
      position: { x: 40, y: 40 },
      ...(selected.payload.slide === 'objects' ? { slidePageId: options.slidePageId } : {}),
    },
  });
}

export async function prepareSlotAddition(options: {
  base: LibraryBasis;
  catalog: TemplateCatalog;
  items: ComponentDefinition[];
  instance: ReuseInstance;
  slotId: string;
  slotComponent: string;
  slotText: string;
}) {
  const { base, catalog, instance, slotId, slotText } = options;
  const child = options.items.find((d) => d.definitionId === options.slotComponent);
  return prepareComponentSlot({
    ...base,
    instanceId: instance.id,
    slotId,
    values: [
      child
        ? {
            kind: 'component',
            definition: child,
            closure: await catalog.closure(definitionRef(child)),
          }
        : {
            kind: 'body',
            content: {
              schemaVersion: 2,
              blocks: [{ id: 'body', type: 'paragraph', text: slotText }],
            },
          },
    ],
  });
}

export async function downloadComponentPack(
  catalog: TemplateCatalog,
  selected: ComponentDefinition,
  closure?: LockedClosure<unknown>,
) {
  const text = await exportTemplatePack(
    [],
    [closure ?? (await catalog.closure(definitionRef(selected)))],
  );
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'reusable-components.json';
  link.click();
  URL.revokeObjectURL(url);
}

export function prepareComponentChange(options: {
  base: LibraryBasis;
  catalog: TemplateCatalog;
  target: LibraryTarget;
  selected: ComponentDefinition;
  selection: {
    closure?: LockedClosure<unknown>;
    instance?: ReuseInstance;
    inputs: Record<string, JsonValue>;
    changed: string[];
    variant: string;
    variantChanged: boolean;
    mode: string;
    modeChanged: boolean;
    initialSlots: Record<string, ComponentSlotValue[]>;
    dataTarget: TemplateTarget;
  };
  reuse: 'linked' | 'copy';
  slidePageId: string;
}) {
  const { base, selection: s } = options;
  return s.instance
    ? prepareInstanceSettings({ base, ...s, instance: s.instance })
    : prepareLibraryInsertion({
        base,
        catalog: options.catalog,
        target: options.target,
        selected: options.selected,
        closure: s.closure,
        inputs: s.inputs,
        slots: s.initialSlots,
        variant: s.variant,
        variantChanged: s.variantChanged,
        mode: s.mode,
        reuse: options.reuse,
        dataTarget: s.dataTarget,
        slidePageId: options.slidePageId,
      });
}
