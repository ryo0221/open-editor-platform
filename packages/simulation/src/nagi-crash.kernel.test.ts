import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  f101Bodies,
  f101NagiCrashBiw,
  f29Groups,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { validateSimulation } from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import {
  nagiCrashAnalysis,
  nagiCrashEndMs,
  nagiCrashMasses,
  nagiCrashMeshMm,
  nagiCrashPoints,
  nagiHeadAnalysis,
} from './nagi-crash';
import { runStudy, type RunEnvironment } from './run';

/**
 * TS-2237 (ST-625, VS8c-2): 凪's crash and head impact documents from the evaluated F101: every
 * sheet but the mounts and the hood with its thickness, the version's weld rows, the rim bonds,
 * the masses, the two crash studies; the hood alone for the headform. A crash run asks the kernel
 * for no finer mesh around the weld points.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const available = existsSync(path.join(kernel, cadKernelBuild.wasm));

describe.skipIf(!available)('凪 crash documents on F101 (VS8c-2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  beforeAll(async () => {
    const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(
      pathToFileURL(path.join(kernel, cadKernelBuild.js)).href
    );
    oc = await factory({ wasmBinary: wasm });
  }, 300_000);

  it('builds the crash and head documents and runs the crash without weld refinement', async () => {
    const cad = f101NagiCrashBiw();
    const evaluated = await evaluateCad(oc, cad, cadContentHash(cad));
    expect(evaluated.evaluation.status).toBe('ok');
    const tables = new Map<string, CadTopologyTable>(
      evaluated.meshes.filter((m) => !m.lod).map((m) => [m.bodyId, m.topology]),
    );
    const weldPoints = new Map(
      (evaluated.evaluation.status === 'ok' ? (evaluated.evaluation.spotWelds ?? []) : []).flatMap(
        (r) => (r.status === 'ok' ? [[r.id, r.points.length / 3] as const] : []),
      ),
    );
    const doc = nagiCrashAnalysis({ cad, tables, weldPoints });
    expect(validateSimulation(doc)).toEqual([]);
    const mounts = new Set<string>(f29Groups.mount);
    const sheets = cad.bodies.map((b) => b.id).filter((id) => !mounts.has(id) && id !== 'hood');
    expect([doc.source.bodyId, ...(doc.bodies ?? []).map((b) => b.bodyId)].sort()).toEqual(
      [...sheets].sort(),
    );
    expect(sheets).toEqual(expect.arrayContaining(['crash-box', 'crash-box-r', 'bumper']));
    expect(f101Bodies).toContain('hood');
    expect(doc.spotWelds).toHaveLength(cad.spotWelds!.length);
    // Per side: 3 pillars on the sill and the rail, 3 cross members on the sill, the rear member,
    // the front extension, the apron, the tower and the two ends of the crash box.
    expect(doc.bonds).toHaveLength(2 * 15);
    expect((doc.masses ?? []).map((m) => m.mass)).toEqual(nagiCrashMasses.map((m) => m.mass));
    expect(doc.mesh.size).toBe(nagiCrashMeshMm);
    expect(doc.mesh.minSize).toBe(nagiCrashMeshMm / 2);
    expect(doc.studies.map((s) => s.id)).toEqual(['front', 'pole']);
    for (const s of doc.studies)
      if (s.kind === 'crash') {
        expect(s.crash.endTimeMs).toBe(nagiCrashEndMs);
        expect(s.crash.gravity).toBe(false);
        expect(s.crash.intrusions).toHaveLength(2);
      }

    // The pole strikes the side of the measurement points (y < 0): the solver's right.
    const pole = doc.studies.find((s) => s.id === 'pole')!;
    expect(pole.kind === 'crash' && pole.crash.pole?.side).toBe('right');
    expect(nagiCrashPoints.accelerometer[1]).toBeLessThan(0);
    // A right part's own thickness wins over its left part's.
    const thick = nagiCrashAnalysis({
      cad,
      tables,
      weldPoints,
      thicknessMm: { sill: 1.6, 'sill-r': 2 },
    });
    const sheet = (id: string) => thick.sheets?.find((t) => t.bodyId === id)?.thicknessMm;
    expect([sheet('sill'), sheet('sill-r'), sheet('rail-r')]).toEqual([1.6, 2, 1.2]);

    const head = nagiHeadAnalysis({ cad, tables, weldPoints });
    expect(validateSimulation(head)).toEqual([]);
    expect(head.source.bodyId).toBe('hood');
    expect(head.bodies ?? []).toHaveLength(0);
    expect(head.studies.map((s) => s.kind)).toEqual(['crash']);

    // The crash run's surface requests: the mesh size, no point sizes around the welds.
    const requests: { bodyId: string; pointSizes?: unknown; maxEdgeMm?: number }[] = [];
    const env: RunEnvironment = {
      builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'fem-mesher', solver: 'geometry-fem' },
      surface: async (_c, request) => {
        requests.push(request);
        throw new Error('stop after the request');
      },
      mesh: () => {
        throw new Error('not reached');
      },
      spotWelds: async () => ({
        rows: evaluated.evaluation.status === 'ok' ? (evaluated.evaluation.spotWelds ?? []) : [],
        tables,
      }),
    };
    const failed = await runStudy(
      doc,
      cad,
      cadContentHash(cad),
      'front',
      tables.get('floor')!,
      env,
      tables,
    ).then(
      (r) => JSON.stringify(r.failure),
      (e: unknown) => String(e),
    );
    expect(requests.length, failed).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.pointSizes).toBeUndefined();
      expect(r.maxEdgeMm).toBe(nagiCrashMeshMm);
    }
  }, 600_000);
});
