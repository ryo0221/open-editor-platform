import { describe, expect, it } from 'vitest';
import { applyCadOperation, mm, r2bJoints, type CadTopologyTable } from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import {
  connectorFromPick,
  jointMoveFrames,
  jointMoves,
  newJoint,
  originChoice,
} from './joint-authoring';

const table: CadTopologyTable = {
  faces: [
    { name: ['end'], centroid: [40, 25, 5], area: 4000 },
    { name: ['side:+u'], centroid: [80, 25, 2.5], area: 250 },
    { name: ['side:+v'], centroid: [40, 50, 2.5], area: 400 },
    { name: null, centroid: [0, 0, 0], area: 1 },
  ],
  edges: [
    { faces: [0, 1], vertices: [0, 1], centroid: [80, 25, 5], length: 50 },
    { faces: [0, 2], vertices: [1, 2], centroid: [40, 50, 5], length: 80 },
    { faces: [1, 2], vertices: [1, 3], centroid: [80, 50, 2.5], length: 5 },
    { faces: [3, 0], vertices: [2, 4], centroid: [0, 0, 0], length: 1 },
  ],
  vertices: [
    { centroid: [80, 0, 5] },
    { centroid: [80, 50, 5] },
    { centroid: [0, 50, 5] },
    { centroid: [80, 50, 0] },
    { centroid: [0, 0, 0] },
  ],
};
const mesh = { bodyId: 'plate', topology: table } as CadMesh;

describe('making a joint (R2b-2c)', () => {
  const { assembly, closure } = r2bJoints();
  const lookup = (h: string) => closure.get(h);

  it('makes connectors from picks on this document and inside a placed part', () => {
    const own = connectorFromPick(
      assembly,
      lookup,
      { mesh, kind: 'vertex', index: 1, point: [80, 50, 5] },
      'parent',
    );
    if (typeof own === 'string') throw new Error(own);
    expect(own.connector).toMatchObject({
      componentPath: [],
      ref: {
        kind: 'vertex',
        featureId: 'plate-cut-placement',
        name: [['end'], ['side:+u'], ['side:+v']],
        hint: { centroid: [80, 50, 5], size: 0 },
      },
      flip: false,
    });
    expect(own.label).toBe('This document · Vertex end | side:+u | side:+v');
    // Inside the pair's plate `pair-b`: the child moves `c-pair`, its connector names the rest.
    const inner = connectorFromPick(
      assembly,
      lookup,
      { path: ['c-pair', 'pair-b'], mesh, kind: 'face', index: 0, point: [0, 0, 0] },
      'child',
    );
    if (typeof inner === 'string') throw new Error(inner);
    expect(inner.componentId).toBe('c-pair');
    expect(inner.connector.componentPath).toEqual(['pair-b']);
    expect(inner.connector.ref).toMatchObject({ kind: 'face', name: [['end']] });
  });

  it('refuses a child on this document, an unnamed element and a missing body', () => {
    const pick = {
      mesh,
      kind: 'face' as const,
      index: 0,
      point: [0, 0, 0] as [number, number, number],
    };
    expect(connectorFromPick(assembly, lookup, pick, 'child')).toBe('joint-child-own');
    expect(connectorFromPick(assembly, lookup, { ...pick, index: 3 }, 'parent')).toBe(
      'reference-unnamed',
    );
    const other = { ...pick, mesh: { ...mesh, bodyId: 'gone' } as CadMesh };
    expect(connectorFromPick(assembly, lookup, other, 'parent')).toBe('joint-connector-body');
    expect(originChoice(assembly, undefined, 'child')).toBe('joint-child-own');
    expect(originChoice(assembly, 'nowhere', 'parent')).toBe('target-missing');
  });

  it('hangs a joint from a pattern copy, never moves one (R2b-3)', () => {
    const doc = applyCadOperation(assembly, {
      type: 'insertComponentPattern',
      pattern: {
        id: 'p-pair',
        name: 'Pairs',
        seedComponentId: 'c-pair',
        layout: { type: 'linear', direction: [0, 1, 0], count: { literal: 3 }, spacing: mm(60) },
      },
    });
    const pick = {
      path: ['copy:p-pair:2', 'pair-b'],
      mesh,
      kind: 'face' as const,
      index: 0,
      point: [0, 0, 0] as [number, number, number],
    };
    const parent = connectorFromPick(doc, lookup, pick, 'parent');
    if (typeof parent === 'string') throw new Error(parent);
    expect(parent.connector.componentPath).toEqual(['copy:p-pair:2', 'pair-b']);
    expect(parent.label).toBe('Pairs 3 › pair-b · Face end');
    expect(connectorFromPick(doc, lookup, pick, 'child')).toBe('joint-child-copy');
    const origin = originChoice(doc, 'copy:p-pair:1', 'parent');
    expect(typeof origin === 'object' && origin.label).toBe('Pairs 2 · Origin');
    expect(originChoice(doc, 'copy:p-pair:1', 'child')).toBe('joint-child-copy');
    // Past the count there is no copy.
    expect(originChoice(doc, 'copy:p-pair:3', 'parent')).toBe('target-missing');
    // Turning the shaft turns its copies about their own places, and what hangs from them.
    const turned = applyCadOperation(doc, {
      type: 'insertComponentPattern',
      pattern: {
        id: 'p-shaft',
        name: 'Shafts',
        seedComponentId: 'c-shaft',
        layout: { type: 'linear', direction: [1, 0, 0], count: { literal: 2 }, spacing: mm(200) },
      },
    });
    const turn = turned.joints.find((j) => j.id === 'j-turn')!;
    const frames = jointMoveFrames(turned, turn);
    expect(frames.get('c-shaft')).toEqual({ translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(frames.get('copy:p-shaft:1')?.translationMm).toEqual([200, 0, 0]);
    expect([...jointMoves(turned, turn)].sort()).toEqual(['c-plate-2', 'c-plate-3', 'c-shaft']);
    // What hangs from a copy moves about the copy's place: a drag cannot start on it.
    const hung = structuredClone(turned);
    hung.joints.push({
      ...structuredClone(turn),
      id: 'j-cap',
      parent: { ...structuredClone(turn.parent), componentPath: ['copy:p-shaft:1'] },
      child: { ...structuredClone(turn.child), componentId: 'c-plate-1' },
    });
    expect(jointMoveFrames(hung, turn).get('c-plate-1')?.translationMm).toEqual([200, 0, 0]);
    expect(jointMoves(hung, turn).has('c-plate-1')).toBe(false);
  });

  it('starts a joint at zero values under a free name, and drags move its subtree', () => {
    const parent = originChoice(assembly, undefined, 'parent');
    const child = originChoice(assembly, 'c-plate-1', 'child');
    if (typeof parent === 'string' || typeof child === 'string') throw new Error('choice');
    const joint = newJoint(assembly, 'j-new', parent, child, 'planar', true);
    expect(joint).toMatchObject({
      id: 'j-new',
      name: 'Joint 6',
      parent: { componentPath: [], ref: { origin: true } },
      child: { componentId: 'c-plate-1', connector: { componentPath: [], flip: true } },
      values: { u: { literalMm: 0 }, v: { literalMm: 0 }, angle: { literalRad: 0 } },
      limits: [],
    });
    const slide = assembly.joints.find((j) => j.id === 'j-slide')!;
    expect([...jointMoves(assembly, slide)].sort()).toEqual(['c-plate-2', 'c-plate-3']);
    const turn = assembly.joints.find((j) => j.id === 'j-turn')!;
    expect([...jointMoves(assembly, turn)].sort()).toEqual(['c-plate-2', 'c-plate-3', 'c-shaft']);
  });
});
