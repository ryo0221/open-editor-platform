import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  decodeNodeOfficeImage,
  OfficeImageDecodeError,
} from '@editor-platform/office-adapters/node';
import { runOfficeImageDecoder } from './node-decoder';

const input = { sha256: 'fixed-test-input', bytes: 1, mime: 'image/png', width: 1, height: 1 };
function run(
  program: string,
  overrides: Partial<Parameters<typeof runOfficeImageDecoder>[0]> = {},
) {
  return runOfficeImageDecoder({
    start: () => spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'pipe'] }),
    bytes: new Uint8Array([1]),
    input,
    operation: 'check',
    timeoutMs: 2_000,
    outputLimit: 1024,
    ...overrides,
  });
}

it.each([
  [65, 'input-rejected'],
  [66, 'conversion-failed'],
  [1, 'process-exit'],
] as const)('distinguishes decoder exit %s without inventing a timeout', async (code, reason) => {
  const error = await run(
    `process.stderr.write('x'.repeat(6000)); process.exitCode=${code};`,
  ).catch((e) => e);
  expect(error).toBeInstanceOf(OfficeImageDecodeError);
  expect(error.diagnostics).toMatchObject({
    reason,
    exitCode: code,
    signal: null,
    input,
    operation: 'check',
  });
  expect(error.diagnostics.stderr).toHaveLength(4096);
  expect(Object.isFrozen(error.diagnostics)).toBe(true);
});

it('kills and reaps a stalled child with a distinct deadline result', async () => {
  let child: ReturnType<typeof spawn>;
  const error = await run('', {
    start: () =>
      (child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })),
    timeoutMs: 100,
  }).catch((e) => e);
  expect(error.diagnostics).toMatchObject({ reason: 'timeout', exitCode: null, signal: 'SIGKILL' });
  expect(() => process.kill(child!.pid!, 0)).toThrow();
});

it('distinguishes external termination from its own deadline', async () => {
  const error = await run('', {
    start: () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.once('spawn', () => child.kill('SIGTERM'));
      return child;
    },
  }).catch((e) => e);
  expect(error.diagnostics).toMatchObject({ reason: 'signal', exitCode: null, signal: 'SIGTERM' });
});

it('reports launch failure and output-limit termination separately', async () => {
  const missing = await run('', {
    start: () => spawn('/nonexistent-office-decoder', [], { stdio: ['pipe', 'pipe', 'pipe'] }),
  }).catch((e) => e);
  expect(missing.diagnostics).toMatchObject({ reason: 'spawn', spawnCode: 'ENOENT' });
  const large = await run('process.stdout.write(Buffer.alloc(2048));', { outputLimit: 16 }).catch(
    (e) => e,
  );
  expect(large.diagnostics.reason).toBe('output-limit');
  expect(large.diagnostics.outputBytes).toBeGreaterThan(16);
});

it('cancellation kills the child and public cancellation remains AbortError', async () => {
  const controller = new AbortController();
  const error = await run('', {
    signal: controller.signal,
    start: () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.once('spawn', () => controller.abort());
      return child;
    },
  }).catch((e) => e);
  expect(error.diagnostics).toMatchObject({ reason: 'cancelled', signal: 'SIGKILL' });
  const bytes = new Uint8Array(await readFile('tests/fixtures/office/images/quadrants.png'));
  await expect(decodeNodeOfficeImage(bytes, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(await run("process.stdout.write('decoded')")).toEqual(Buffer.from('decoded'));
});

it('identifies a real malformed GIF failure and keeps later decoding usable', async () => {
  // A valid dimension header reaches the native codec, but there are no frames.
  const bytes = new Uint8Array([...Buffer.from('GIF89a'), 1, 0, 1, 0, 0, 0, 0]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const error = await decodeNodeOfficeImage(bytes).catch((e) => e);
  expect(error).toBeInstanceOf(OfficeImageDecodeError);
  expect(error.diagnostics.input).toMatchObject({ sha256, bytes: bytes.length, mime: 'image/gif' });
  // Native builds can reject cleanly or terminate. Either must preserve its actual cause.
  if (error.diagnostics.signal) {
    expect(error.diagnostics).toMatchObject({ reason: 'signal', exitCode: null });
  } else {
    expect(error.diagnostics).toMatchObject({ reason: 'input-rejected', exitCode: 65 });
  }
  expect(error.message).toContain(sha256);
  expect(error.diagnostics.input).not.toHaveProperty('data');
  const valid = new Uint8Array(await readFile('tests/fixtures/office/images/quadrants.png'));
  await expect(decodeNodeOfficeImage(valid)).resolves.toMatchObject({ mime: 'image/png' });
});
