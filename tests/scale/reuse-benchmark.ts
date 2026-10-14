import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, totalmem, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector';
import { clone } from '@editor-platform/artifact-core';
import {
  Authority,
  operation,
  localAdapter,
  type Receipt,
} from '@editor-platform/collaboration-core';
import { resolveTokens } from '@editor-platform/reuse-core';
import { isDocument } from '@editor-platform/document/model';
import { contentToNode } from '@editor-platform/document/engine';
import {
  prepareComponentInsertion,
  previewComponentUpdate,
  previewArtifactMode,
  patchReusablePart,
  reusablePartText,
  reusableNativeActions,
  reusableParts,
  templateCodec,
  type PreparedApplication,
} from '@editor-platform/templates';
import {
  largeTokenSet,
  reuseScaleFixture,
  reuseScaleTarget,
  scaleIdentity,
  scalePrincipal,
  type ReuseScaleDomain,
  type ReuseScaleFixture,
} from './reuse-fixtures';

const output = process.argv[2];
if (!output)
  throw Error('Pass an output directory; use REUSE_SCALE_SMOKE=1 for a diagnostic single sample');
await mkdir(output, { recursive: true });
const domains = (
  process.argv[3] === 'tokens'
    ? []
    : process.argv[3]
      ? [process.argv[3]]
      : ['design', 'slide', 'document']
) as ReuseScaleDomain[];
assert.ok(domains.every((d) => ['design', 'slide', 'document'].includes(d)));
const smoke = process.env.REUSE_SCALE_SMOKE === '1';
const warmDiagnostic = process.env.REUSE_SCALE_WARM_DIAGNOSTIC === '1';
const counts = warmDiagnostic
  ? { repetitions: 1, warmups: 5, samples: 3 }
  : smoke
    ? { repetitions: 1, warmups: 0, samples: 1 }
    : { repetitions: 3, warmups: 5, samples: 20 };
const profile = process.env.PROFILE_REUSE === '1' ? new Session() : undefined;
const post = (method: string) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    profile!.post(method, (error, result) =>
      error ? reject(error) : resolve((result ?? {}) as Record<string, unknown>),
    );
  });
if (profile) {
  profile.connect();
  await post('Profiler.enable');
  await post('Profiler.start');
}
const metadata = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  node: process.version,
  v8: process.versions.v8,
  platform: platform(),
  cpus: cpus().length,
  cpuModel: cpus()[0]?.model,
  memoryBytes: totalmem(),
  smoke,
  warmDiagnostic,
  profiled: !!profile,
  domains,
  ...counts,
  transport: 'public localAdapter and Authority in-process; no HTTP latency in authority timings',
  timed: {
    tokens: 'two complete public resolveTokens calls, light then dark, including validation',
    nested:
      'public prepareComponentInsertion promise, including input ownership, closure validation, native projection and proposal preparation',
    preview:
      'public previewComponentUpdate promise for all 50 instances, including conflict checks and prepared native operation',
    modePreview:
      'public previewArtifactMode promise for the same 50 instances, light to dark, including preparation',
    commit:
      'localAdapter.submit promise, including authority authorization, conditions, validation, native execution and receipt',
    undo: 'Authority.undo after an accepted independent native body edit; includes selective inverse validation and receipt',
  },
  gc:
    typeof global.gc === 'function'
      ? 'full GC before each sample and after retaining the prepared insertion; GC is outside timing'
      : 'no explicit GC; heap gate unavailable',
  nestedAcceptance:
    'First prepared insertion is committed and selectively undone outside timing, after its heap measurement.',
};
await writeFile(join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
type Sample = {
  repetition: number;
  index: number;
  warmup: boolean;
  ms: number;
  error?: string;
  heapDeltaBytes?: number;
  nativeBytes?: number;
  closureBytes?: number;
};
const samples: Record<string, { budgetMs: number; values: Sample[] }> = {};
const now = () => performance.now();
const gc = () => global.gc?.();
const accepted = (r: Receipt) => assert.equal(r.status, 'accepted', JSON.stringify(r));
function record(key: string, budgetMs: number, value: Sample) {
  (samples[key] ??= { budgetMs, values: [] }).values.push(value);
  console.log(JSON.stringify({ condition: key, ...value }));
}
async function persist() {
  const summary = Object.fromEntries(
    Object.entries(samples).map(([key, { budgetMs, values }]) => {
      const repetitions = Array.from({ length: counts.repetitions }, (_, repetition) => {
        const rows = values.filter((v) => v.repetition === repetition && !v.warmup);
        const sorted = rows
          .filter((v) => !v.error)
          .map((v) => v.ms)
          .sort((a, b) => a - b);
        const p95Ms = sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
        return {
          repetition,
          sampleCount: rows.length,
          failures: rows.filter((v) => v.error).length,
          p95Ms,
          maxMs: sorted.at(-1) ?? null,
          meetsBudget:
            rows.length === counts.samples &&
            !rows.some((v) => v.error) &&
            p95Ms !== null &&
            p95Ms <= budgetMs,
        };
      });
      return [key, { budgetMs, repetitions, samples: values }];
    }),
  );
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ metadata, conditions: summary }, null, 2),
  );
}
const tokens = largeTokenSet();
try {
  for (let repetition = 0; repetition < counts.repetitions; repetition++)
    for (let i = -counts.warmups; i < counts.samples; i++) {
      gc();
      const start = now();
      const light = resolveTokens(tokens, { artifactMode: 'light' });
      const dark = resolveTokens(tokens, { artifactMode: 'dark' });
      const ms = now() - start;
      assert.equal(Object.keys(light.tokens).length, 2048);
      assert.equal(Object.keys(dark.tokens).length, 2048);
      assert.notDeepEqual(light.tokens['token.2047'].value, dark.tokens['token.2047'].value);
      record('tokens-light-dark', 100, { repetition, index: i, warmup: i < 0, ms });
    }
  await persist();
  for (const domain of domains) {
    const fixtureFile = join(process.env.REUSE_SCALE_FIXTURES ?? output, `${domain}-fixture.json`);
    let fixture: ReuseScaleFixture;
    try {
      fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      console.log(JSON.stringify({ generating: domain, startedAt: new Date().toISOString() }));
      fixture = await reuseScaleFixture(domain);
      await writeFile(fixtureFile, JSON.stringify(fixture));
    }
    const fixtureBytes = await readFile(fixtureFile);
    await writeFile(
      join(output, `${domain}-fixture-hash.json`),
      JSON.stringify(
        {
          fixtureFile,
          bytes: fixtureBytes.length,
          sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
        },
        null,
        2,
      ),
    );
    const codec = templateCodec(domain);
    const selections = (
      'reuse' in fixture.update.state.content ? fixture.update.state.content.reuse!.instances : []
    ).map((i) => ({ instanceId: i.id, choice: 'adopt' as const }));
    assert.equal(selections.length, 50);
    const originalParts = reusableParts(fixture.update.state.content);
    const originalBodies = fixture.update.bodyAddresses.map((id) =>
      reusablePartText(originalParts.get(id)!),
    );
    const assertStyle = (content: PreparedApplication['preview'], color: string) => {
      assert.ok('reuse' in content && content.reuse);
      const parts = reusableParts(content);
      for (const instance of content.reuse.instances)
        for (const binding of fixture.update.definition.payload.styles!) {
          const part = parts.get(instance.parts[binding.partId])!;
          const style = (domain === 'document' ? part.style : part.typography) as
            | { color?: string }
            | undefined;
          assert.equal(style?.color, color);
        }
      return parts;
    };
    assertStyle(fixture.update.state.content, '#336699');
    for (let repetition = 0; repetition < counts.repetitions; repetition++)
      for (let i = -counts.warmups; i < counts.samples; i++) {
        const label = { repetition, index: i, warmup: i < 0 };
        gc();
        const heapBefore = process.memoryUsage().heapUsed;
        let start = now();
        try {
          let inserted: PreparedApplication | undefined = await prepareComponentInsertion({
            ...fixture.nested,
            identity: scaleIdentity,
            reuse: 'linked',
            target: reuseScaleTarget(domain),
            requestId: `nested-${domain}-${repetition}-${i + counts.warmups}`,
          });
          const ms = now() - start;
          assert.ok('reuse' in inserted.preview && inserted.preview.reuse);
          assert.equal(inserted.preview.reuse.instances.length, 10);
          assert.equal(
            inserted.preview.reuse.instances.reduce(
              (n, value) => n + Object.keys(value.parts).length,
              0,
            ),
            1000,
          );
          const nativeBytes = Buffer.byteLength(JSON.stringify(inserted.preview));
          const closureBytes = Buffer.byteLength(JSON.stringify(inserted.preview.reuse.closures));
          gc();
          const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
          assert.ok(nativeBytes <= 10 * 1024 ** 2, '1000-part native fixture exceeds 10 MiB');
          if (global.gc)
            assert.ok(heapDeltaBytes < 256 * 1024 ** 2, 'Additional retained heap exceeds 256 MiB');
          if (repetition === 0 && i === -counts.warmups) {
            const authority = new Authority(codec, fixture.nested.state);
            const receipt = authority.commit(scalePrincipal, inserted.operation);
            accepted(receipt);
            assert.deepEqual(authority.snapshot().content, inserted.preview);
            accepted(authority.undo(scalePrincipal, receipt.operationId));
            const after = authority.snapshot().content;
            if (isDocument(after) && isDocument(fixture.nested.state.content))
              assert.deepEqual(
                contentToNode(after).toJSON(),
                contentToNode(fixture.nested.state.content).toJSON(),
              );
            else assert.deepEqual(after, fixture.nested.state.content);
            await writeFile(
              join(output, `${domain}-nested-acceptance.json`),
              JSON.stringify({ commit: receipt, undone: authority.snapshot().content }, null, 2),
            );
          }
          record(`${domain}-nested`, 3000, {
            ...label,
            ms,
            nativeBytes,
            closureBytes,
            heapDeltaBytes,
          });
          if (repetition === 0 && i === 0)
            await writeFile(
              join(output, `${domain}-nested.native.json`),
              JSON.stringify(inserted.preview),
            );
          inserted = undefined;
        } catch (error) {
          record(`${domain}-nested`, 3000, { ...label, ms: now() - start, error: String(error) });
          await persist();
          throw error;
        }
        await persist();
        gc();
        start = now();
        let prepared: PreparedApplication;
        try {
          const preview = await previewComponentUpdate({
            definition: fixture.update.definition,
            closure: fixture.update.closure,
            state: fixture.update.state,
            identity: scaleIdentity,
            selections,
            requestId: `update-${domain}-${repetition}-${i + counts.warmups}`,
          });
          const ms = now() - start;
          assert.equal(preview.conflicts.length, 0, JSON.stringify(preview.conflicts));
          assert.ok(preview.prepared);
          prepared = preview.prepared;
          record(`${domain}-preview`, 3000, { ...label, ms });
        } catch (error) {
          record(`${domain}-preview`, 3000, { ...label, ms: now() - start, error: String(error) });
          await persist();
          throw error;
        }
        await persist();
        gc();
        start = now();
        try {
          const mode = await previewArtifactMode({
            state: fixture.update.state,
            identity: scaleIdentity,
            mode: 'dark',
            requestId: `mode-${domain}-${repetition}-${i + counts.warmups}`,
          });
          const ms = now() - start;
          assert.equal(mode.conflicts.length, 0, JSON.stringify(mode.conflicts));
          assert.ok(mode.prepared);
          const parts = assertStyle(mode.prepared.preview, '#99ccff');
          assert.deepEqual(
            fixture.update.bodyAddresses.map((id) => reusablePartText(parts.get(id)!)),
            originalBodies,
          );
          record(`${domain}-mode-preview`, 3000, { ...label, ms });
        } catch (error) {
          record(`${domain}-mode-preview`, 3000, {
            ...label,
            ms: now() - start,
            error: String(error),
          });
          await persist();
          throw error;
        }
        const authority = new Authority(codec, fixture.update.state);
        const adapter = localAdapter(authority, clone(scalePrincipal));
        gc();
        start = now();
        const receipt = await adapter.submit(prepared.operation);
        const commitMs = now() - start;
        record(`${domain}-commit`, 1000, {
          ...label,
          ms: commitMs,
          ...(receipt.status === 'rejected' ? { error: JSON.stringify(receipt) } : {}),
        });
        accepted(receipt);
        const adopted = authority.snapshot();
        assert.ok('reuse' in adopted.content && adopted.content.reuse);
        assert.ok(adopted.content.reuse.instances.every((v) => v.ref.version === 2));
        const adoptedParts = assertStyle(adopted.content, '#99331a');
        assert.deepEqual(
          fixture.update.bodyAddresses.map((id) => reusablePartText(adoptedParts.get(id)!)),
          originalBodies,
        );
        const next = clone(adopted.content),
          address = fixture.update.bodyAddresses[0];
        const peerText = originalBodies[0] + ' 別の人の追記';
        patchReusablePart(
          next,
          address,
          {
            text: peerText,
            ...(isDocument(next) ? { rich: [{ text: peerText }] } : { runs: [{ text: peerText }] }),
          },
          domain === 'design',
        );
        const peer = {
          ...scalePrincipal,
          actorId: 'scale-peer',
          clientId: 'peer',
          sessionId: 'peer',
        };
        accepted(
          authority.commit(
            peer,
            operation(codec, adopted, peer, reusableNativeActions(adopted, peer, next)),
          ),
        );
        gc();
        start = now();
        const undone = authority.undo(scalePrincipal, receipt.operationId);
        const undoMs = now() - start;
        record(`${domain}-undo`, 1000, {
          ...label,
          ms: undoMs,
          ...(undone.status === 'rejected' ? { error: JSON.stringify(undone) } : {}),
        });
        accepted(undone);
        const after = authority.snapshot().content;
        const afterParts = assertStyle(after, '#336699');
        assert.equal(reusablePartText(afterParts.get(address)!), peerText);
        assert.ok(
          'reuse' in after &&
            after.reuse &&
            after.reuse.instances.every((v) => v.ref.version === 1),
        );
        assert.equal(
          after.reuse.instances[0].inputs[fixture.update.textProperty],
          originalBodies[0],
        );
        await persist();
      }
  }
} finally {
  await persist();
  if (profile) {
    const result = await post('Profiler.stop');
    await writeFile(join(output, 'profile.cpuprofile'), JSON.stringify(result.profile));
    profile.disconnect();
  }
}
