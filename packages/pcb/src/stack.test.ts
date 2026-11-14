import { describe, expect, it } from 'vitest';
import { f76HatBoard, pcbStackPlacement, type PcbStackedBoard } from '@editor-platform/pcb-core';
import { pcbFaceSheet, pcbPlacedSheet } from './scene3d';
import { pcbCurrentStacked, type PcbBoardSource } from './stack';
import { pcbStackSources } from './view3d';

// PB8b (ST-471, TS-1958): a stacked board's face pictures go where its pieces go.

describe('stacked face sheets (PB8b)', () => {
  it('TS-1958: turns and lifts the sheet as the stacked board', () => {
    const hat = f76HatBoard();
    const entry: PcbStackedBoard = {
      id: 's',
      name: 'HAT',
      source: { artifactId: 'a', versionId: 'v', contentHash: 'a'.repeat(64) },
      at: [10, 5],
      rotationDeg: 90,
      gapMm: 11,
    };
    const sheet = pcbFaceSheet(hat, 'top');
    const placed = pcbPlacedSheet(sheet, pcbStackPlacement(hat, entry));
    expect(placed.indices).toBe(sheet.indices);
    expect(placed.uvs).toBe(sheet.uvs);
    // (x, y, z) → (10 − y, 5 + x, z + 1.6 + 11); the normal stays up.
    for (let i = 0; i < sheet.positions.length; i += 3) {
      expect(placed.positions[i]).toBeCloseTo(10 - sheet.positions[i + 1]!, 4);
      expect(placed.positions[i + 1]).toBeCloseTo(5 + sheet.positions[i]!, 4);
      expect(placed.positions[i + 2]).toBeCloseTo(sheet.positions[i + 2]! + 12.6, 4);
      expect([...placed.normals.subarray(i, i + 3)]).toEqual([0, 0, 1]);
    }
    // The bottom sheet's normal stays down.
    const bottom = pcbPlacedSheet(pcbFaceSheet(hat, 'bottom'), pcbStackPlacement(hat, entry));
    expect([...bottom.normals.subarray(0, 3)]).toEqual([0, 0, -1]);
  });

  it('TS-1958: a host that does not stack boards still gets a board without a stack built', () => {
    const hat = f76HatBoard();
    // `stacked` left out: no stack builds at once; a stack waits to be read.
    expect(pcbStackSources(hat, undefined)).toEqual([]);
    const entry: PcbStackedBoard = {
      id: 's',
      name: 'HAT',
      source: { artifactId: 'a', versionId: 'v', contentHash: 'a'.repeat(64) },
      at: [0, 0],
      rotationDeg: 0,
      gapMm: 11,
    };
    expect(pcbStackSources({ ...hat, stack: [entry] }, undefined)).toBeUndefined();
    const read = [{ entry, doc: hat }];
    expect(pcbStackSources({ ...hat, stack: [entry] }, read)).toBe(read);
  });
});

// #1108 review (TS-1964): boards read without a source (2D) are not shown once 3D gives one.
describe('stacked boards read for the current source (TS-1964)', () => {
  it('TS-1964: a read from another source counts as still reading', () => {
    const hat = f76HatBoard();
    const entry: PcbStackedBoard = {
      id: 's',
      name: 'HAT',
      source: { artifactId: 'a', versionId: 'v', contentHash: 'a'.repeat(64) },
      at: [0, 0],
      rotationDeg: 0,
      gapMm: 11,
    };
    const key = JSON.stringify([entry]);
    const host: PcbBoardSource = {
      list: async () => [],
      document: async () => hat,
    };
    const without = {
      key,
      source: undefined,
      boards: [{ entry, error: 'board-source-unavailable' }],
    };
    expect(pcbCurrentStacked(without, key, undefined)).toBe(without.boards);
    // 3D opened: the source is the Host's now; the cached "unavailable" read is not used.
    expect(pcbCurrentStacked(without, key, host)).toBeUndefined();
    // …so the 3D view waits for the stack instead of building the base board alone.
    expect(
      pcbStackSources({ ...hat, stack: [entry] }, pcbCurrentStacked(without, key, host)),
    ).toBeUndefined();
    const read = { key, source: host, boards: [{ entry, doc: hat }] };
    expect(pcbCurrentStacked(read, key, host)).toBe(read.boards);
    expect(pcbCurrentStacked(read, 'other', host)).toBeUndefined();
  });
});
