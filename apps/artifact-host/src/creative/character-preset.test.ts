import { describe, expect, it } from 'vitest';
import {
  designDrawings,
  designInstanceElements,
  isDesign,
  overrideInstance,
  updateComponentPart,
  validDesignRasterProvenance,
  type DesignContent,
} from '@editor-platform/design/model';
import { characterComponentId, characterGroups, createCharacterDesign } from './character-preset';

const instanceIds = ['instance-candidate-1', 'instance-candidate-2', 'instance-candidate-3'];
function definitionPart(content: DesignContent, id: string) {
  return content.components
    .find((component) => component.id === characterComponentId)!
    .elements!.find((part) => part.id === id)!;
}
function instance(content: DesignContent, id: string) {
  return content.elements.find((element) => element.id === id)!;
}
function projectedPart(content: DesignContent, instanceId: string, partId: string) {
  return designInstanceElements(content, instance(content, instanceId)).find(
    (part) => part.id === partId,
  )!;
}
function localBounds(content: DesignContent, instanceId: string, partId: string) {
  const owner = instance(content, instanceId);
  const { x, y, width, height } = projectedPart(content, instanceId, partId).bounds;
  return { x: x - owner.bounds.x, y: y - owner.bounds.y, width, height };
}

describe('Host character rough preset', () => {
  it('creates deterministic native Design JSON with three separate candidate frames', () => {
    const content = createCharacterDesign('灯');
    const saved: unknown = JSON.parse(JSON.stringify(content));
    expect(isDesign(content)).toBe(true);
    expect(isDesign(saved)).toBe(true);
    expect(saved).toEqual(content);
    expect(createCharacterDesign('灯')).toEqual(content);
    expect(content.schemaVersion).toBe(2);
    const frames = content.elements.filter((element) => element.type === 'frame');
    expect(frames).toMatchObject([
      { id: 'candidate-1', name: '灯 / 制服' },
      { id: 'candidate-2', name: '灯 / 私服' },
      { id: 'candidate-3', name: '灯 / 戦闘服' },
    ]);
    expect(frames.every((frame) => frame.parentId === undefined)).toBe(true);
    expect(content.components).toHaveLength(1);
    expect(content.components[0].id).toBe(characterComponentId);
    expect(content.components[0].elements!.some((part) => part.type === 'instance')).toBe(false);
    for (const [index, id] of instanceIds.entries()) {
      expect(instance(content, id)).toMatchObject({
        type: 'instance',
        parentId: `candidate-${index + 1}`,
        componentId: characterComponentId,
      });
      expect(Object.keys(instance(content, id).overrides!)).toEqual(['outerwear']);
    }
    expect(
      [...content.elements, ...content.components[0].elements!].some((part) => part.path),
    ).toBe(false);
  });

  it('maps all Host groups and leaves to ordinary component element IDs', () => {
    const content = createCharacterDesign('灯');
    expect(characterGroups.map((group) => group.label)).toEqual([
      '顔',
      '髪',
      '身体',
      '服装',
      '小物',
    ]);
    const ids = new Set<string>();
    for (const group of characterGroups) {
      expect(definitionPart(content, group.id)).toMatchObject({
        type: 'group',
        name: group.label,
      });
      ids.add(group.id);
      for (const part of group.parts) {
        const native = definitionPart(content, part.id);
        expect(native).toMatchObject({ name: part.label, parentId: group.id });
        expect(native.type).not.toBe('group');
        expect(native.type).not.toBe('instance');
        ids.add(part.id);
      }
    }
    expect(ids.size).toBe(content.components[0].elements!.length);
    expect(definitionPart(content, 'eyes')).toMatchObject({ type: 'shape', vector: {} });
    for (const id of instanceIds) {
      const drawings = designDrawings(content, instance(content, id));
      expect(drawings.some((drawing) => drawing.vector && drawing.fill === '#587c99')).toBe(true);
      expect(drawings.some((drawing) => drawing.kind === 'image' && drawing.src)).toBe(true);
    }
  });

  it('keeps a hair bounds override local and retains every untouched leaf', () => {
    const before = createCharacterDesign('灯');
    const originalHair = definitionPart(before, 'hair-front');
    const bounds = {
      ...originalHair.bounds,
      x: originalHair.bounds.x + 12,
      y: originalHair.bounds.y + 4,
    };
    const next = overrideInstance(instanceIds[0], 'hair-front', { bounds }).apply(before);
    expect(isDesign(next)).toBe(true);
    expect(localBounds(next, instanceIds[0], 'hair-front')).toEqual(bounds);
    for (const id of instanceIds.slice(1)) {
      expect(instance(next, id)).toEqual(instance(before, id));
      expect(localBounds(next, id, 'hair-front')).toEqual(originalHair.bounds);
    }
    expect(next.components).toEqual(before.components);
    for (const group of characterGroups)
      for (const part of group.parts.filter((part) => part.id !== 'hair-front'))
        expect(projectedPart(next, instanceIds[0], part.id)).toEqual(
          projectedPart(before, instanceIds[0], part.id),
        );
    expect(instance(before, instanceIds[0]).overrides?.['hair-front']).toBeUndefined();
  });

  it('propagates shared hair bounds and vector eye fill to all three candidates', () => {
    const before = createCharacterDesign('灯');
    const bounds = { ...definitionPart(before, 'hair-front').bounds, x: 74, y: 39 };
    let next = updateComponentPart(characterComponentId, 'hair-front', { bounds }).apply(before);
    next = updateComponentPart(characterComponentId, 'eyes', { fill: '#537c54' }).apply(next);
    expect(isDesign(next)).toBe(true);
    for (const id of instanceIds) {
      expect(localBounds(next, id, 'hair-front')).toEqual(bounds);
      expect(projectedPart(next, id, 'eyes').fill).toBe('#537c54');
      expect(projectedPart(next, id, 'eyes').vector).toEqual(definitionPart(before, 'eyes').vector);
      expect(instance(next, id).overrides?.['hair-front']).toBeUndefined();
      expect(instance(next, id).overrides?.eyes).toBeUndefined();
      expect(projectedPart(next, id, 'torso')).toEqual(projectedPart(before, id, 'torso'));
    }
    for (const part of before.components[0].elements!.filter(
      (part) => part.id !== 'hair-front' && part.id !== 'eyes',
    ))
      expect(definitionPart(next, part.id)).toEqual(part);
    expect(next.elements).toEqual(before.elements);
    expect(isDesign(JSON.parse(JSON.stringify(next)))).toBe(true);
  });

  it('retains distinct self-authored clothing sources and replaces provenance only on the target', () => {
    const before = createCharacterDesign('灯');
    const outfits = instanceIds.map((id) => projectedPart(before, id, 'outerwear'));
    expect(new Set(outfits.map((outfit) => outfit.src)).size).toBe(3);
    for (const outfit of outfits) {
      expect(outfit.src).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(validDesignRasterProvenance(outfit.provenance)).toBe(true);
      expect(outfit.provenance!.src).toBe(outfit.src);
      expect(outfit.provenance!.source).toContain('自作');
      expect(outfit.provenance!.license).toContain('Host sample');
      expect(outfit.provenance!.license).not.toContain('CC0');
    }
    const src = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="#f80" d="M0 0h2v2H0z"/></svg>')}`;
    const provenance = { src, source: 'Test Host / 自作差替ラフ', license: 'Test Host sample' };
    const next = overrideInstance(instanceIds[1], 'outerwear', { src, provenance }).apply(before);
    expect(isDesign(next)).toBe(true);
    expect(projectedPart(next, instanceIds[1], 'outerwear')).toMatchObject({ src, provenance });
    expect(next.components).toEqual(before.components);
    for (const id of [instanceIds[0], instanceIds[2]])
      expect(instance(next, id)).toEqual(instance(before, id));
    for (const group of characterGroups)
      for (const part of group.parts.filter((part) => part.id !== 'outerwear'))
        expect(projectedPart(next, instanceIds[1], part.id)).toEqual(
          projectedPart(before, instanceIds[1], part.id),
        );
    const reloaded = JSON.parse(JSON.stringify(next)) as DesignContent;
    expect(isDesign(reloaded)).toBe(true);
    expect(projectedPart(reloaded, instanceIds[1], 'outerwear').provenance).toEqual(provenance);
  });
});
