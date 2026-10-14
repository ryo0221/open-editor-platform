import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { command, withCommandReads, type EditorCommand } from '@editor-platform/editor-core';
import { isDesign, type DesignContent, type DesignComponent, type DesignElement } from './model';
import {
  validDesignWebComponent,
  designWebTagsFor,
  type DesignWebComponent,
  type DesignWebTag,
} from './web-contract';
/** A singleton becomes a one-part native definition, preserving its original appearance. */
export function publicationParts(component: DesignComponent): DesignElement[] {
  return component.elements?.length
    ? clone(component.elements)
    : [
        {
          ...clone(component.template),
          id: `${component.id}:root`,
          name: component.name,
          bounds: { x: 0, y: 0, width: component.width, height: component.height },
        },
      ];
}
export function publishDesignComponent(
  content: DesignContent,
  id: string,
  web: DesignWebComponent,
  semantics: Record<string, DesignWebTag>,
): EditorCommand<DesignContent> {
  const component = content.components.find((component) => component.id === id);
  if (!component || !validDesignWebComponent(web))
    throw new Error('公開props・slots・symbol・versionを確認してください。');
  const base = canonicalJson(component);
  const next = {
    ...clone(component),
    web: clone(web),
    elements: publicationParts(component).map((part) => ({
      ...part,
      ...(semantics[part.id] ? { web: { ...part.web, tag: semantics[part.id] } } : {}),
    })),
  };
  if (
    next.elements.some(
      (part) => part.type !== 'react' && part.type !== 'instance' && !part.web?.tag,
    )
  )
    throw new Error('各native部品のHTML意味を設定してください。');
  if (
    next.elements.some(
      (part) => part.type === 'image' && !designWebTagsFor(part.type).includes(part.web!.tag!),
    )
  )
    throw new Error(
      '画像部品のHTML意味はimgにしてください。画像を保持できない設定は公開できません。',
    );
  if (
    content.web?.publications?.some(
      (ref) =>
        ref.registryId === 'native-design' && ref.componentId === id && ref.version === web.version,
    ) &&
    canonicalJson(next) !== base
  )
    throw new Error('この公開版は変更できません。versionを新しい番号にして保存してください。');
  const partIds = new Set(next.elements.map((part) => part.id));
  if (
    Object.values(web.props).some((prop) => !partIds.has(prop.target.elementId)) ||
    Object.values(web.slots ?? {}).some((slot) => !partIds.has(slot.elementId))
  )
    throw new Error('公開propsまたはslotsの参照先がありません。部品を選び直してください。');
  for (const [name, prop] of Object.entries(web.props)) {
    const part = next.elements.find((part) => part.id === prop.target.elementId)!;
    if (
      part.type !== 'react' &&
      part.type !== 'instance' &&
      !(part.web?.tag === 'img' ? ['src', 'alt'] : ['text', 'fill']).includes(prop.target.field)
    )
      throw new Error(`公開prop ${name}: ${part.web?.tag}.${prop.target.field} は表示されません。`);
  }
  for (const [name, slot] of Object.entries(web.slots ?? {})) {
    const part = next.elements.find((part) => part.id === slot.elementId)!;
    if (
      part.type === 'react' ||
      part.type === 'instance' ||
      !part.web?.tag ||
      part.web.tag === 'img'
    )
      throw new Error(`公開slot ${name}: 画像以外のnative HTML部品を選択してください。`);
  }
  return withCommandReads(
    command('design.web.component', 'Publish native React contract', (current) => {
      if (canonicalJson(current.components.find((component) => component.id === id)) !== base)
        throw new Error('部品定義が変更されました。設定を開き直してください。');
      if (
        canonicalJson(next) !== base &&
        current.web?.publications?.some(
          (ref) =>
            ref.registryId === 'native-design' &&
            ref.componentId === id &&
            ref.version === web.version,
        )
      )
        throw new Error('この公開版は変更できません。versionを新しい番号にして保存してください。');
      const updated = {
        ...current,
        elements: current.elements.map((element) => {
          if (component.elements?.length || element.componentId !== id || !element.overrides?.root)
            return element;
          const { root, ...rest } = element.overrides;
          return { ...element, overrides: { ...rest, [`${id}:root`]: root } };
        }),
        components: current.components.map((component) =>
          component.id === id ? clone(next) : component,
        ),
      };
      if (!isDesign(updated)) throw new Error('公開設定がnative Designの契約を満たしていません。');
      return updated;
    }),
    { content: ['*'] },
  );
}
