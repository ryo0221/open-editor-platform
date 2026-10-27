import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers';
import { pathToFileURL } from 'node:url';
import * as fixtures from '@editor-platform/cad-core';
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { createKernelHost } from './host';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';

/**
 * CAD60 (R2c-1): the CAD evaluation of every fixture document, as digests of its evaluation,
 * meshes and STEP bytes, written to `CAD_EQUIVALENCE_OUT`. Run before and after a change to the
 * kernel packages and compare the two files; they must be equal. Opt-in: it needs the
 * development build (`CAD_OCCT_DIST`).
 */
const dist = process.env.CAD_OCCT_DIST;
const out = process.env.CAD_EQUIVALENCE_OUT;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const view = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** The fixtures' documents: every `f..`/`r1..` export that builds one with its default arguments. */
function documents(): [string, CadDocument][] {
  const docs: [string, CadDocument][] = [];
  for (const [name, f] of Object.entries(fixtures)) {
    if (!/^(f\d\d|r\d)/.test(name) || typeof f !== 'function' || f.length > 0) continue;
    let doc: unknown;
    try {
      doc = (f as () => unknown)();
    } catch {
      continue;
    }
    if (doc && typeof doc === 'object' && 'kernelProfile' in doc && 'features' in doc)
      docs.push([name, doc as CadDocument]);
  }
  // Variants the defaults do not reach.
  const c = fixtures;
  for (const k of ['linear', 'circular', 'twice', 'mirror'] as const)
    docs.push([`f14Patterns:${k}`, c.f14Patterns(k)]);
  for (const k of ['extrude', 'closed', 'revolve'] as const)
    docs.push([`f17Sheets:${k}`, c.f17Sheets(k)]);
  for (const k of ['loft', 'closed', 'sweep'] as const)
    docs.push([`f17Surfaces:${k}`, c.f17Surfaces(k)]);
  for (const k of ['hypar', 'quarter', 'fill', 'cap', 'dome', 'edgeLoft'] as const)
    docs.push([`f17Boundaries:${k}`, c.f17Boundaries(k)]);
  for (const k of ['sheets', 'sew', 'trim'] as const) docs.push([`f18Hood:${k}`, c.f18Hood(k)]);
  docs.push(['f18Sheets:box', c.f18Sheets({ kind: 'box' })]);
  for (const k of [
    { kind: 'bend', angleDeg: 30 },
    { kind: 'tangent' },
    { kind: 'smooth' },
  ] as const)
    docs.push([`f18Seams:${k.kind}`, c.f18Seams(k)]);
  docs.push(['f15Loft:square', c.f15Loft('square')]);
  docs.push(['f15Sweep:fixed', c.f15Sweep('fixed')]);
  docs.push(['f13ShellDraft:draft', c.f13ShellDraft({ draft: true })]);
  return docs;
}

describe.skipIf(!dist || !out)('CAD evaluation digests (CAD60)', () => {
  it('writes the digests of every fixture evaluation', async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    const buildHash = `sha256:${digest(wasm)}`;
    globalThis.require ??= createRequire(import.meta.url);
    const posted: CadWorkerResponse[] = [];
    const handle = createKernelHost({
      load: async () => {
        const { default: factory } = await import(
          pathToFileURL(`${dist}/${cadKernelBuild.js}`).href
        );
        return factory({ wasmBinary: wasm });
      },
      post: (m) => void posted.push(m),
      yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await handle({ type: 'init', build: { buildHash, moduleUrl: '', wasmUrl: '' } });
    const result: Record<string, unknown> = {};
    const docs = documents();
    expect(docs.length).toBeGreaterThan(10);
    for (const [name, doc] of docs) {
      const document = { ...doc, kernelProfile: { ...doc.kernelProfile, buildHash } };
      const request: CadWorkerRequest = {
        type: 'evaluate',
        requestId: name,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
        step: true,
      };
      await handle(request);
      const r = posted.find((m) => m.type === 'result' && m.requestId === name);
      if (r?.type !== 'result') {
        result[name] = { response: r?.type ?? 'none' };
        continue;
      }
      result[name] = {
        evaluation: digest(JSON.stringify(r.evaluation)),
        status: r.evaluation.status,
        meshes: r.meshes.map((m) =>
          digest(
            JSON.stringify({
              bodyId: m.bodyId,
              origin: m.origin,
              topology: m.topology,
              faceBase: m.faceBase,
              edgeBase: m.edgeBase,
              arrays: [
                m.positions,
                m.normals,
                m.indices,
                m.faceIds,
                m.vertices,
                m.edges,
                m.edgeIds,
              ].map((a) => digest(view(a))),
            }),
          ),
        ),
        // The header's time stamp is the only part that changes between runs.
        ...(r.step
          ? {
              step: digest(
                new TextDecoder()
                  .decode(r.step)
                  .replace(/FILE_NAME\('([^']*)','[^']*'/, "FILE_NAME('$1',''"),
              ),
            }
          : {}),
      };
    }
    mkdirSync(out!.replace(/\/[^/]*$/, ''), { recursive: true });
    writeFileSync(out!, `${JSON.stringify({ buildHash, documents: result }, null, 2)}\n`);
  }, 1_800_000);
});
