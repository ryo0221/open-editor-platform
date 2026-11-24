import { expect, it } from 'vitest';
import { Authority, initial, type DomainCodec, type Principal } from '@editor-platform/collaboration-core';
import { immutableCommand } from '@editor-platform/editor-core';
import { drawingStarter } from '@editor-platform/drawing-core';
import { pcbStarter } from '@editor-platform/pcb-core';
import { newConstruction } from '@editor-platform/construction-core';
import { newFactory } from '@editor-platform/factory-core';
import { cosimStarter } from '@editor-platform/cosim-core';
import { applyCadOperation, f02Plate } from '@editor-platform/cad-core';
import { applyBimOperation, bimStarter } from '@editor-platform/bim-core';
import { applyCharacterOperation, blockyFigure } from '@editor-platform/character-core';
import { applySimulationOperation, simulationFixture } from '@editor-platform/simulation-core';
import {
  bimEditorCodec,
  cadEditorCodec,
  characterEditorCodec,
  simulationEditorCodec,
  constructionEditorCodec,
  cosimEditorCodec,
  drawingEditorCodec,
  factoryEditorCodec,
  pcbEditorCodec,
  prepareEditorCommand,
} from './index';

const actor = (id: string): Principal => ({
  actorId: id, clientId: id, sessionId: id, writable: true, scopes: ['*'],
});
const a = actor('a');
const b = actor('b');
const scenario = <T>(codec: DomainCodec<T>, document: T) => {
  const snapshot = initial(codec.domain, codec, document);
  return {
    authority: new Authority(codec, snapshot),
    edit: (author: Principal, apply: (content: T) => T) =>
      prepareEditorCommand(codec, snapshot, author, immutableCommand('test-edit', 'Edit', apply))!,
  };
};

it('combines Drawing sheet edits and preserves the peer edit when undoing', () => {
  const document = drawingStarter();
  const { authority, edit } = scenario(drawingEditorCodec, document);
  const rename = edit(a, (doc) => ({
    ...doc, sheets: doc.sheets.map((sheet) => ({ ...sheet, name: 'First drawing' })),
  }));
  const filing = edit(b, (doc) => ({
    ...doc, sheets: doc.sheets.map((sheet) => ({ ...sheet, filing: !sheet.filing })),
  }));
  expect(authority.submit(a, rename).status).toBe('accepted');
  expect(authority.submit(b, filing).status).toBe('accepted');
  expect(authority.undo(a, rename.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.sheets[0]).toMatchObject({
    name: document.sheets[0].name, filing: !document.sheets[0].filing,
  });
});

it('updates a PCB rule and rejects a direct edit that would remove required net classes', () => {
  const document = pcbStarter();
  const { authority, edit } = scenario(pcbEditorCodec, document);
  expect(authority.submit(a, edit(a, (doc) => ({
    ...doc, netClasses: doc.netClasses.map((rule) => ({ ...rule, name: 'Signal' })),
  }))).status).toBe('accepted');
  expect(() => pcbEditorCodec.apply(document, {
    type: 'pcb.edit', target: '*', payload: { reads: [], changes: document.netClasses.map((rule) => ({
      kind: 'remove', collection: 'netClasses', id: rule.id,
    })) },
  }, 0)).toThrow(/invariants/);
});

const pin = { artifactId: 'source', versionId: 'v1', contentHash: 'a'.repeat(64) };

it('shares Construction task changes and preserves the pinned Building version across restores', () => {
  const document = newConstruction('Build', pin, '2026-07-01');
  document.tasks.push({ id: 'task', name: 'Prepare', durationDays: 2, predecessors: [], action: 'construct', elementIds: [] });
  const { authority, edit } = scenario(constructionEditorCodec, document);
  expect(authority.submit(a, edit(a, (doc) => ({
    ...doc, tasks: doc.tasks.map((task) => ({ ...task, durationDays: 3 })),
  }))).status).toBe('accepted');
  expect(authority.snapshot().content.tasks[0].durationDays).toBe(3);
  expect(() => constructionEditorCodec.apply(document, {
    type: 'domain.restore', target: '*',
    payload: { content: { ...document, source: { ...pin, versionId: 'v2' } } },
  }, 0)).toThrow(/参照元/);
});

it('shares independent equipment edits in a self-contained Factory line', () => {
  const document = newFactory('Line');
  document.objects.push({ id: 'one', name: 'One', kind: 'drain' }, { id: 'two', name: 'Two', kind: 'drain' });
  const { authority, edit } = scenario(factoryEditorCodec, document);
  const rename = (id: string) => (doc: typeof document) => ({
    ...doc, objects: doc.objects.map((object) => object.id === id ? { ...object, name: object.name + ' edited' } : object),
  });
  const first = edit(a, rename('one'));
  expect(authority.submit(a, first).status).toBe('accepted');
  expect(authority.submit(b, edit(b, rename('two'))).status).toBe('accepted');
  expect(authority.undo(a, first.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.objects.map((object) => object.name)).toEqual(['One', 'Two edited']);
});

it('shares CoSim bindings and refuses direct changes to pinned circuit or ladder versions', () => {
  const document = { ...cosimStarter(), schematic: pin, ladder: { ...pin, artifactId: 'program' } };
  const { authority, edit } = scenario(cosimEditorCodec, document);
  const binding = { variable: 'Ready', net: 'Net1', kind: 'input' as const };
  expect(authority.submit(a, edit(a, (doc) => ({ ...doc, bindings: [binding] }))).status).toBe('accepted');
  expect(authority.snapshot().content.bindings).toEqual([binding]);
  expect(() => cosimEditorCodec.apply(document, {
    type: 'cosim.edit', target: '*', payload: { reads: [], changes: [{
      kind: 'root', field: 'ladder', present: true, value: { ...document.ladder, versionId: 'v2' },
    }] },
  }, 0)).toThrow(/Unknown domain property/);
});


it('checks the CAD recipe as one dependency and allows independent part properties', () => {
  const document = f02Plate();
  const { authority, edit } = scenario(cadEditorCodec, document);
  const dimension = edit(a, (doc) => applyCadOperation(doc, {
    type: 'setParameter', parameterId: 'W', value: 100,
  }));
  const renameBody = edit(b, (doc) => applyCadOperation(doc, {
    type: 'rename', targetId: doc.bodies[0]!.id, name: 'Plate edited by B',
  }));
  const inventory = edit(b, (doc) => ({
    ...doc, partProperties: { ...doc.partProperties, partNumber: 'NEW-01' },
  }));
  expect(authority.submit(a, dimension).status).toBe('accepted');
  expect(authority.submit(b, renameBody).status).toBe('rejected');
  expect(authority.submit(b, inventory).status).toBe('accepted');
  expect(authority.undo(a, dimension.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.partProperties.partNumber).toBe('NEW-01');
  expect(authority.snapshot().content.parameters).toEqual(document.parameters);
});

it('merges edits on separate building levels and gives Undo to the author', () => {
  const document = bimStarter();
  const { authority, edit } = scenario(bimEditorCodec, document);
  const rename = (index: number, name: string) => (doc: typeof document) =>
    applyBimOperation(doc, { type: 'update', collection: 'levels', entity: { ...doc.levels[index]!, name } });
  const first = edit(a, rename(0, 'Ground'));
  expect(authority.submit(a, first).status).toBe('accepted');
  expect(authority.submit(b, edit(b, rename(1, 'Upper'))).status).toBe('accepted');
  expect(authority.undo(a, first.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.levels.map((level) => level.name)).toEqual(['1F', 'Upper', 'RF']);
});

it('keeps shared Character edits independent of fixed mesh topology', () => {
  const { doc: document } = blockyFigure();
  const part = document.parts[0]!;
  const { authority, edit } = scenario(characterEditorCodec, document);
  const rename = edit(a, (doc) => applyCharacterOperation(doc, {
    type: 'rename', collection: 'parts', id: part.id, name: 'Renamed part',
  }));
  const visibility = edit(b, (doc) => applyCharacterOperation(doc, {
    type: 'setPartVisible', id: part.id, visible: false,
  }));
  expect(authority.submit(a, rename).status).toBe('accepted');
  expect(authority.submit(b, visibility).status).toBe('accepted');
  expect(authority.undo(a, rename.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.parts[0]).toMatchObject({ name: part.name, visible: false });
  expect(() => characterEditorCodec.apply(document, {
    type: 'character.edit', target: '*', payload: { reads: [], changes: [{
      kind: 'field', collection: 'parts', id: part.id, field: 'mesh', value: 'another-mesh',
    }] },
  }, 0)).toThrow(/Unknown domain field/);
});

it('edits Simulation inputs without moving the reference or persisting solver results', () => {
  const { doc: document } = simulationFixture();
  const { authority, edit } = scenario(simulationEditorCodec, document);
  const mesh = edit(a, (doc) => applySimulationOperation(doc, {
    type: 'setMeshSettings', mesh: { ...doc.mesh, size: doc.mesh.size * 2 },
  }));
  expect(authority.submit(a, mesh).status).toBe('accepted');
  expect(authority.snapshot().content.mesh.size).toBe(document.mesh.size * 2);
  expect(() => simulationEditorCodec.apply(document, {
    type: 'domain.restore', target: '*', payload: {
      content: { ...document, source: { ...document.source, versionId: 'changed-version' } },
    },
  }, 0)).toThrow(/参照元/);
  expect(() => simulationEditorCodec.apply(document, {
    type: 'simulation.edit', target: '*', payload: { reads: [], changes: [{
      kind: 'root', field: 'runs', value: [],
    }] },
  }, 0)).toThrow(/Unknown domain property/);
});
