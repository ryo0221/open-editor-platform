import { describe, expect, it } from 'vitest';
import {
  designDrawings,
  designInstanceElements,
  isDesign,
  validDesignRasterProvenance,
  validDesignVector,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  creativeDesignAddressKey,
  creativeDesignEditCommand,
  designCreativeProposalDiff,
  prepareCreativeDesignProposal,
} from '@editor-platform/design/creative-proposal-diff';
import { EditorSession, previewProposedCommands } from '@editor-platform/editor-core';
import { createSettingDesign, settingComponentId, settingGroups } from './setting-preset';

const day = 'instance-candidate-1';
const night = 'instance-candidate-2';
const room = 'instance-candidate-3';
const winter = 'instance-candidate-4';
const instances = [day, night, room, winter];
const address = (elementId: string, instanceId?: string) => ({
  componentId: settingComponentId,
  elementId,
  ...(instanceId ? { instanceId } : {}),
});
function definition(content: DesignContent, id: string) {
  return content.components[0].elements!.find((part) => part.id === id)!;
}
function owner(content: DesignContent, id: string) {
  return content.elements.find((element) => element.id === id)!;
}
function projected(content: DesignContent, instanceId: string, partId: string) {
  return designInstanceElements(content, owner(content, instanceId)).find(
    (part) => part.id === partId,
  )!;
}
function localBounds(content: DesignContent, instanceId: string, partId: string) {
  const origin = owner(content, instanceId).bounds;
  const { x, y, width, height } = projected(content, instanceId, partId).bounds;
  return { x: x - origin.x, y: y - origin.y, width, height };
}

describe('Host setting rough preset', () => {
  it('creates deterministic native Design with separate day, night, interior and winter frames', () => {
    const content = createSettingDesign('風見の家');
    expect(isDesign(content)).toBe(true);
    expect(isDesign(JSON.parse(JSON.stringify(content)))).toBe(true);
    expect(createSettingDesign('風見の家')).toEqual(content);
    expect(content.components).toHaveLength(1);
    expect(content.components[0].id).toBe('component-setting');
    expect(content.elements.filter(({ type }) => type === 'frame')).toMatchObject([
      { id: 'candidate-1', name: '風見の家 / 全景・昼' },
      { id: 'candidate-2', name: '風見の家 / 全景・夜' },
      { id: 'candidate-3', name: '風見の家 / 室内' },
      { id: 'candidate-4', name: '風見の家 / 冬' },
    ]);
    for (const [index, id] of instances.entries()) {
      expect(owner(content, id)).toMatchObject({
        type: 'instance',
        parentId: `candidate-${index + 1}`,
        componentId: settingComponentId,
      });
      expect(designDrawings(content, owner(content, id)).some((drawing) => drawing.src)).toBe(true);
    }
    expect(content.components[0].elements!.some(({ type }) => type === 'instance')).toBe(false);
    expect([...content.elements, ...content.components[0].elements!].some(({ path }) => path)).toBe(
      false,
    );
  });

  it('maps all building, interior and background parts to existing component elements', () => {
    const content = createSettingDesign('家');
    expect(settingGroups.map(({ label }) => label)).toEqual(['建物', '室内', '背景']);
    const mappedIds = new Set<string>();
    for (const group of settingGroups) {
      expect(definition(content, group.id)).toMatchObject({ type: 'group', name: group.label });
      mappedIds.add(group.id);
      for (const part of group.parts) {
        expect(definition(content, part.id)).toMatchObject({
          name: part.label,
          parentId: group.id,
        });
        expect(definition(content, part.id).type).not.toBe('group');
        mappedIds.add(part.id);
      }
    }
    expect(mappedIds.size).toBe(content.components[0].elements!.length);
    for (const id of ['roof', 'windows']) {
      expect(definition(content, id).type).toBe('shape');
      expect(validDesignVector(definition(content, id).vector)).toBe(true);
    }
  });

  it('uses candidate-local night overrides while the roof and native geometry stay shared', () => {
    const content = createSettingDesign('家');
    expect(owner(content, day).overrides).toBeUndefined();
    expect(Object.keys(owner(content, night).overrides!).sort()).toEqual([
      'background',
      'sky',
      'wall',
      'windows',
    ]);
    expect(projected(content, day, 'sky').fill).toBe('#d8eaf0');
    expect(projected(content, night, 'sky').fill).toBe('#172d49');
    expect(projected(content, night, 'windows').fill).toBe('#ffe0a0');
    expect(projected(content, day, 'windows').fill).toBe('#a6c9d1');
    expect(localBounds(content, night, 'roof')).toEqual(localBounds(content, day, 'roof'));
    expect(projected(content, night, 'windows').vector).toEqual(
      definition(content, 'windows').vector,
    );
    expect(projected(content, room, 'roof').hidden).toBe(true);
    expect(projected(content, room, 'furniture').hidden).not.toBe(true);
    expect(projected(content, winter, 'roof').fill).toBe('#edf1ed');
    expect(definition(content, 'roof').fill).toBe('#9f6557');
  });

  it('keeps a roof transform local to one candidate and Undo/Redo in the native Session', () => {
    const before = createSettingDesign('家');
    const bounds = { ...definition(before, 'roof').bounds, x: 91, y: 68 };
    const session = new EditorSession(before);
    session.execute(creativeDesignEditCommand(address('roof', day), { bounds }));
    const next = session.content;
    expect(isDesign(next)).toBe(true);
    expect(localBounds(next, day, 'roof')).toEqual(bounds);
    expect(next.components).toEqual(before.components);
    for (const id of [night, room, winter]) expect(owner(next, id)).toEqual(owner(before, id));
    for (const part of settingGroups
      .flatMap(({ parts }) => parts)
      .filter(({ id }) => id !== 'roof'))
      expect(projected(next, day, part.id)).toEqual(projected(before, day, part.id));
    session.undo();
    expect(session.content).toEqual(before);
    expect(session.canUndo).toBe(false);
    session.redo();
    expect(session.content).toEqual(next);
  });

  it('propagates shared roof position through every candidate and retains local night appearance', () => {
    const before = createSettingDesign('家');
    const bounds = { ...definition(before, 'roof').bounds, x: 80, y: 66 };
    const next = creativeDesignEditCommand(address('roof'), { bounds }).apply(before);
    for (const id of instances) expect(localBounds(next, id, 'roof')).toEqual(bounds);
    expect(projected(next, night, 'windows')).toEqual(projected(before, night, 'windows'));
    expect(projected(next, winter, 'roof').fill).toBe('#edf1ed');
    expect(projected(next, room, 'roof').hidden).toBe(true);
    expect(next.elements).toEqual(before.elements);
    expect(definition(before, 'roof').bounds).not.toEqual(bounds);
  });

  it('uses qualified scope for a nonempty AI roof edit and rejects changes outside it', () => {
    const before = createSettingDesign('家');
    const session = new EditorSession(before);
    const target = address('roof', day);
    const proposal = prepareCreativeDesignProposal(
      {
        id: 'roof-proposal',
        summary: '昼の屋根を移動',
        baseLocalRevision: session.revision,
        commands: [
          creativeDesignEditCommand(target, {
            bounds: { ...definition(before, 'roof').bounds, y: 67 },
          }),
        ],
      },
      { required: [target] },
    );
    const preview = previewProposedCommands(before, proposal);
    expect(session.content).toEqual(before);
    const diff = designCreativeProposalDiff.diff(before, preview.content);
    expect(diff.fallback).toEqual([]);
    expect([...new Set(diff.changes.map(({ elementId }) => elementId))]).toEqual([
      creativeDesignAddressKey(target),
    ]);
    const outside = prepareCreativeDesignProposal(
      {
        id: 'outside-proposal',
        summary: '指定外',
        baseLocalRevision: session.revision,
        commands: [
          ...proposal.commands,
          creativeDesignEditCommand(address('windows', night), { fill: '#ffcc77' }),
        ],
      },
      { required: [target] },
    );
    expect(() => previewProposedCommands(before, outside)).toThrow();
  });

  it('keeps hidden and locked window edits local and rejects protected transformations', () => {
    const before = createSettingDesign('家');
    const target = address('windows', day);
    const hidden = creativeDesignEditCommand(target, { hidden: true }).apply(before);
    expect(projected(hidden, day, 'windows').hidden).toBe(true);
    expect(owner(hidden, night)).toEqual(owner(before, night));
    expect(() => creativeDesignEditCommand(target, { fill: '#fff' }).apply(hidden)).toThrow();
    const visible = creativeDesignEditCommand(target, { hidden: false }).apply(hidden);
    const locked = creativeDesignEditCommand(target, { locked: true }).apply(visible);
    expect(projected(locked, day, 'windows').locked).toBe(true);
    expect(() =>
      creativeDesignEditCommand(target, {
        bounds: { x: 130, y: 163, width: 170, height: 57 },
      }).apply(locked),
    ).toThrow();
    const unlocked = creativeDesignEditCommand(target, { locked: false }).apply(locked);
    expect(projected(unlocked, day, 'windows').locked).toBe(false);
    expect(isDesign(unlocked)).toBe(true);
  });

  it('retains bound self-authored background provenance and replaces only the requested source', () => {
    const before = createSettingDesign('家');
    const backgrounds = instances.map((id) => projected(before, id, 'background'));
    expect(new Set(backgrounds.map(({ src }) => src)).size).toBe(4);
    for (const background of backgrounds) {
      expect(background.src).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(validDesignRasterProvenance(background.provenance)).toBe(true);
      expect(background.provenance!.src).toBe(background.src);
      expect(background.provenance!.source).toContain('自作');
      expect(background.provenance!.license).toContain('Host sample');
      expect(background.provenance!.license).not.toContain('CC0');
    }
    const src = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="#687c91" d="M0 0h2v2H0Z"/></svg>')}`;
    const provenance = { src, source: 'Test Host / 自作の新遠景', license: 'Test Host sample' };
    const next = creativeDesignEditCommand(address('background', night), { src, provenance }).apply(
      before,
    );
    expect(projected(next, night, 'background')).toMatchObject({ src, provenance });
    for (const id of [day, room, winter]) expect(owner(next, id)).toEqual(owner(before, id));
    expect(next.components).toEqual(before.components);
    const loaded = JSON.parse(JSON.stringify(next)) as DesignContent;
    expect(isDesign(loaded)).toBe(true);
    expect(projected(loaded, night, 'background').provenance).toEqual(provenance);
    const withoutAttribution = creativeDesignEditCommand(address('background', night), {
      src,
    }).apply(before);
    expect(projected(withoutAttribution, night, 'background').provenance).toBeUndefined();
    expect(definition(withoutAttribution, 'background').provenance).toEqual(
      definition(before, 'background').provenance,
    );
  });
});
