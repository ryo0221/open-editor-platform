import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type OfficeImageDecodeFailure =
  | 'input-rejected'
  | 'conversion-failed'
  | 'timeout'
  | 'cancelled'
  | 'signal'
  | 'process-exit'
  | 'spawn'
  | 'output-limit';

export interface OfficeImageDecodeDiagnostics {
  readonly input: Readonly<{
    sha256: string;
    bytes: number;
    mime: string;
    width: number;
    height: number;
  }>;
  readonly operation: 'check' | 'png';
  readonly reason: OfficeImageDecodeFailure;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnCode?: string;
  readonly elapsedMs: number;
  readonly outputBytes: number;
  /** Bounded native-process diagnostics; image bytes are never logged. */
  readonly stderr: string;
}

export class OfficeImageDecodeError extends Error {
  readonly name = 'OfficeImageDecodeError';
  constructor(readonly diagnostics: OfficeImageDecodeDiagnostics) {
    super(
      `Image decoder ${diagnostics.reason} (exit=${diagnostics.exitCode ?? 'none'}, signal=${diagnostics.signal ?? 'none'}, input=${diagnostics.input.sha256})`,
    );
    Object.freeze(diagnostics.input);
    Object.freeze(diagnostics);
  }
}

/** Internal process boundary. Only the trusted, fixed decoder program uses it. */
export function runOfficeImageDecoder({
  start,
  bytes,
  input,
  operation,
  signal,
  timeoutMs,
  outputLimit,
}: {
  start(): ChildProcessWithoutNullStreams;
  bytes: Uint8Array;
  input: OfficeImageDecodeDiagnostics['input'];
  operation: OfficeImageDecodeDiagnostics['operation'];
  signal?: AbortSignal;
  timeoutMs: number;
  outputLimit: number;
}): Promise<Buffer> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = start();
    const output: Buffer[] = [];
    let length = 0,
      stderr = '',
      stopped: 'timeout' | 'cancelled' | 'output-limit' | undefined,
      spawnError: NodeJS.ErrnoException | undefined;
    const stop = (reason: NonNullable<typeof stopped>) => {
      if (!stopped) {
        stopped = reason;
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.stdin.on('error', () => {
      // EPIPE is a consequence, not evidence that the input was rejected.
    });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > outputLimit) stop('output-limit');
      else if (!stopped) output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const reason = spawnError
        ? 'spawn'
        : (stopped ??
          (exitSignal
            ? 'signal'
            : exitCode === 65
              ? 'input-rejected'
              : exitCode === 66
                ? 'conversion-failed'
                : 'process-exit'));
      if (exitCode === 0 && !spawnError && !stopped) resolve(Buffer.concat(output));
      else
        reject(
          new OfficeImageDecodeError({
            input: { ...input },
            operation,
            reason,
            exitCode,
            signal: exitSignal,
            spawnCode: spawnError?.code,
            elapsedMs: performance.now() - started,
            outputBytes: length,
            stderr,
          }),
        );
    });
    if (signal?.aborted) abort();
    child.stdin.end(bytes);
  });
}
