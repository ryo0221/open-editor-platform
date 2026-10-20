import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { time, adoptVideoContentV2, type VideoContentV1 } from './frozen/core';
import {
  prepareMixV2,
  type AudioRequestV2,
} from './frozen/packages/video-metadata/host-media/m2/mix-v2';
import { PcmRenderSession } from './frozen/packages/video-core/experiments/pcm-renderer/session';
import type { WindowPlan } from './frozen/packages/video-core/experiments/pcm-renderer/render';
import { Ledger, prepareModule } from '../../src/pcm/kernel';
import { PcmBackend } from '../../src/pcm/adapter';
import { SelectedPcmSession, APPROVED_WASM_SHA } from '../../src/pcm/selection';
import { sourcePort, type PcmLease } from './port';
const bytes = new Uint8Array(readFileSync(process.argv[2]));
assert.equal(createHash('sha256').update(bytes).digest('hex'), APPROVED_WASM_SHA);
const realm = new Ledger(8 * 1024 * 1024);
const pin = await prepareModule(bytes, APPROVED_WASM_SHA, realm);
const baseline = realm.bytes;
const results: object[] = [];
const evidence = {
  scope: 'port/fixture only; no M2/Host adoption',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  engine: { node: process.version, v8: process.versions.v8 },
  wasmSha256: APPROVED_WASM_SHA,
  results,
};
const signal = () => new AbortController().signal;
const bits = (p: Float32Array) => Array.from(new Uint32Array(p.buffer, p.byteOffset, p.length));
function fixture(count = 2) {
  const v: VideoContentV1 = {
    schema: 'video-core-prototype-v1',
    sources: [],
    sequence: { id: 'sequence', duration: time(1), frameRate: time(25), tracks: [], clips: [] },
  };
  for (let i = 0; i < count; i++) {
    v.sources.push({
      id: `s${i}`,
      asset: { assetId: `a${i}`, sha256: String(i + 1).repeat(64), byteLength: 1 },
      streams: [
        {
          id: 'a',
          kind: 'audio',
          sampleRate: 44100,
          sampleCount: 44100,
          sampleOrigin: time(0),
          validity: { start: time(0), end: time(1) },
          presentationOrigin: time(0),
        },
      ],
    });
    v.sequence.tracks.push({ id: `t${i}`, kind: 'audio', enabled: true, locked: false });
    v.sequence.clips.push({
      id: `c${i}`,
      kind: 'audio',
      sourceId: `s${i}`,
      streamId: 'a',
      trackId: `t${i}`,
      start: time(0),
      duration: time(1),
      sourceIn: time(0),
      sourceOut: time(1),
    });
  }
  return adoptVideoContentV2(v);
}
function decoded(p: WindowPlan, seed: number) {
  const plane = new Float32Array(p.end - p.first);
  const values = [0, -0, 2 ** -149, -(2 ** -149), 0.25, -0.125, 0.5, -0.375];
  for (let i = 0; i < plane.length; i++)
    plane[i] = values[(p.first + i + seed + 800000) % values.length];
  return { first: p.first, rate: p.rate, planes: [plane] };
}
function successfulForced(d: ReturnType<SelectedPcmSession['diagnostics']>) {
  assert.equal(d.backend, 'wasm');
  assert.equal(d.fallback, false);
  assert.ok('wasmSha256' in d && d.wasmSha256 === APPROVED_WASM_SHA);
  assert.ok('invocations' in d && typeof d.invocations === 'number' && d.invocations > 0);
  assert.ok('completions' in d && typeof d.completions === 'number' && d.completions > 0);
  assert.equal(d.completions, d.invocations);
}
async function caseRun(name: string, action: () => Promise<void>) {
  try {
    await action();
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', error: String(error) });
    throw error;
  } finally {
    writeFileSync(
      resolve(process.argv[3], 'results.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
  }
}
try {
  for (const mode of ['js', 'wasm'] as const) {
    await caseRun(
      `${mode}: whole frozen mix/source bits, fades, cuts, endpoints; three resident owners`,
      async () => {
        const content = fixture(3);
        // Three resident sources; only two contribute at any sample. This is not a production peak proof.
        for (const [i, c] of content.sequence.clips.entries()) {
          if (c.kind !== 'audio') throw Error('fixture');
          c.gain = 0.25 + i * 0.125;
          c.fade.in = time(1, 5);
          c.fade.out = time(1, 5);
          if (i === 1) {
            c.duration = time(1, 2);
            c.sourceOut = time(1, 2);
          }
          if (i === 2) {
            c.start = time(1, 2);
            c.duration = time(1, 2);
            c.sourceOut = time(1, 2);
          }
        }
        const sessions = content.sources.map(
          (_, i) =>
            new SelectedPcmSession(
              { decode: async (p) => decoded(p, i) },
              'edge-hold-v0',
              realm,
              mode === 'wasm' ? new PcmBackend({ mode: 'wasm', realm, pin }) : undefined,
            ),
        );
        const ports = sessions.map(sourcePort);
        const old = content.sources.map(
          (_, i) => new PcmRenderSession({ decode: async (p) => decoded(p, i) }, 'edge-hold-v0'),
        );
        const sourceIndex = (r: AudioRequestV2) => Number(r.sourceId.slice(1));
        const oracle = prepareMixV2(content, (r, s) =>
          old[sourceIndex(r)].render(
            r.mapping,
            r.first,
            r.end,
            48000,
            r.stream.sampleRate,
            r.valid,
            1,
            s,
          ),
        );
        let leases: PcmLease[] = [];
        // Fixture collector keeps leases through the entire frozen mix. It is NOT a production mixer port.
        const actual = prepareMixV2(content, async (r, s) => {
          const lease = await ports[sourceIndex(r)].render(r, s);
          leases.push(lease);
          const expected = await old[sourceIndex(r)].render(
            r.mapping,
            r.first,
            r.end,
            48000,
            r.stream.sampleRate,
            r.valid,
            1,
            s,
          );
          assert.deepEqual(bits(lease.planes[0]), bits(expected.planes[0]));
          return lease;
        });
        async function compare(a: number, b: number) {
          try {
            const expected = await oracle.render(a, b, signal());
            const got = await actual.render(a, b, signal());
            assert.deepEqual(bits(got.planes[0]), bits(expected.planes[0]));
            return bits(got.planes[0]);
          } finally {
            for (const lease of leases) lease.release();
            leases = [];
          }
        }
        try {
          await compare(0, 129);
          await compare(47870, 48000);
          const whole = await compare(23900, 24129),
            parts = [
              ...(await compare(23900, 24000)),
              ...(await compare(24000, 24001)),
              ...(await compare(24001, 24129)),
            ];
          assert.deepEqual(parts, whole);
          for (const session of sessions) {
            const d = session.diagnostics();
            assert.equal(d.backend, mode);
            assert.equal(d.fallback, false);
            assert.ok(d.completedRequests > 0);
            if (mode === 'wasm') successfulForced(d);
            results.push({ source: sessions.indexOf(session), ...d });
          }
        } finally {
          for (const lease of leases) lease.release();
          await Promise.all(ports.map((p) => p.dispose()));
          old.forEach((p) => p.dispose());
        }
        assert.equal(realm.bytes, baseline);
      },
    );
    await caseRun(
      `${mode}: consumer lease survives source disposal and release is idempotent`,
      async () => {
        const backend = mode === 'wasm' ? new PcmBackend({ mode: 'wasm', pin, realm }) : undefined;
        const session = new SelectedPcmSession(
            { decode: async (p) => decoded(p, 0) },
            'edge-hold-v0',
            realm,
            backend,
          ),
          port = sourcePort(session);
        const lease = await port.render(
          {
            sourceId: 's',
            first: 0,
            end: 64,
            mapping: { start: time(0), end: time(1), sourceStart: time(0), speed: time(1) },
            valid: { start: time(0), end: time(1) },
            stream: { sampleRate: 44100 },
          },
          signal(),
        );
        if (mode === 'wasm') successfulForced(session.diagnostics());
        await port.dispose();
        assert.equal(realm.bytes, baseline + 64 * 4);
        assert.throws(() => realm.reserve(realm.limit - realm.bytes + 1), /admission/);
        lease.release();
        lease.release();
        assert.equal(realm.bytes, baseline);
      },
    );
    await caseRun(
      `${mode}: abort and dispose retain delayed decode reservation until actual settlement`,
      async () => {
        let finish!: () => void;
        const session = new SelectedPcmSession(
            {
              decode: (p) =>
                new Promise((resolve) => {
                  finish = () => resolve(decoded(p, 0));
                }),
            },
            'edge-hold-v0',
            realm,
            mode === 'wasm' ? new PcmBackend({ mode: 'wasm', pin, realm }) : undefined,
          ),
          port = sourcePort(session),
          abort = new AbortController();
        const work = port
          .render(
            {
              sourceId: 's',
              first: 0,
              end: 64,
              mapping: { start: time(0), end: time(1), sourceStart: time(0), speed: time(1) },
              valid: { start: time(0), end: time(1) },
              stream: { sampleRate: 44100 },
            },
            abort.signal,
          )
          .then(
            () => {
              throw Error('stale publication');
            },
            () => 'rejected',
          );
        await Promise.resolve();
        await Promise.resolve();
        assert.ok(finish);
        abort.abort();
        let drained = false;
        const close = port.dispose();
        assert.equal(port.dispose(), close);
        void close.then(() => {
          drained = true;
        });
        await Promise.resolve();
        assert.equal(drained, false);
        assert.ok(realm.bytes > baseline);
        finish();
        assert.equal(await work, 'rejected');
        await close;
        assert.equal(realm.bytes, baseline);
      },
    );
  }
  await caseRun(
    'port transfer abort/dispose releases an unpublished source lease and drains transfer',
    async () => {
      for (const stop of ['abort', 'dispose'] as const) {
        let deliver!: (value: Awaited<ReturnType<SelectedPcmSession['render']>>) => void;
        const abort = new AbortController();
        const release = realm.reserve(256);
        const port = sourcePort({
          render: () =>
            new Promise((resolve) => {
              deliver = resolve;
            }),
          dispose: async () => {},
        });
        const request = {
          sourceId: 's',
          first: 0,
          end: 64,
          mapping: { start: time(0), end: time(1), sourceStart: time(0), speed: time(1) },
          valid: { start: time(0), end: time(1) },
          stream: { sampleRate: 44100 },
        };
        const work = port.render(request, abort.signal);
        const rejection = assert.rejects(work);
        deliver({ pcm: { first: 0, rate: 48000, planes: [new Float32Array(64)] }, release });
        if (stop === 'abort') abort.abort();
        const close = port.dispose();
        assert.equal(port.dispose(), close);
        await rejection;
        await close;
        assert.equal(realm.bytes, baseline);
        await assert.rejects(port.render(request, signal()), /disposed/);
      }
    },
  );
  await caseRun(
    'frozen final guard remains after all contributors; rejected output not clipped',
    async () => {
      for (const [values, valid] of [
        [[1.5, -1], true],
        [[0.75, 0.75], false],
        [[Infinity, -1], false],
        [[NaN, 0], false],
      ] as const) {
        const mix = prepareMixV2(fixture(), async (r) => ({
          first: r.first,
          rate: 48000,
          planes: [new Float32Array(r.end - r.first).fill(values[Number(r.sourceId.slice(1))])],
        }));
        if (valid)
          assert.deepEqual(
            bits((await mix.render(0, 8, signal())).planes[0]),
            bits(new Float32Array(8).fill(0.5)),
          );
        else await assert.rejects(mix.render(0, 8, signal()), /final mixed/);
      }
    },
  );
  await caseRun('forced backend refuses missing module and exhausted shared ledger', async () => {
    assert.throws(() => new PcmBackend({ mode: 'wasm', realm }), /WASM/);
    const hold = realm.reserve(realm.limit - realm.bytes);
    try {
      assert.throws(() => new PcmBackend({ mode: 'wasm', realm, pin }), /admission/);
    } finally {
      hold();
    }
    assert.equal(realm.bytes, baseline);
  });
} finally {
  await caseRun('module disposal leaves no fixture reservations', async () => {
    pin.dispose();
    assert.equal(realm.bytes, 0);
  });
}
console.log(JSON.stringify(evidence, null, 2));
