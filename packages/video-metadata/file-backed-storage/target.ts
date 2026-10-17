/** Private POSIX-like reference target. Host must own destination exclusively. */
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { SaveCapture } from '@editor-platform/extension-contract/draft2';
import { MAX_ARCHIVE, CHUNK, fileReader, handleReader, need, scan, type Sink } from './io';
import { prepareProject, openProject, type Project } from './project';
import { archiveSize, writeZip } from './zip64';
export interface Receipt {
  operationId: string;
  capture: SaveCapture;
  sha256: string;
  bytes: string;
}
export type Outcome =
  | { state: 'saved'; receipt: Receipt }
  | { state: 'not-written'; reason: string }
  | { state: 'unknown'; receipt: Receipt };
/** Trusted Host target capability: must replace atomically or throw an ambiguous result. */
export type Publish = (stage: string, destination: string) => Promise<void>;
async function publish(stage: string, destination: string) {
  await rename(stage, destination);
  const directory = await open(dirname(destination), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export class FileTarget {
  private busy = false;
  private used = new Set<string>();
  private pending?: { receipt: Receipt; stage: string; publishing: boolean };
  private reconciliation?: Promise<Outcome>;
  constructor(
    readonly destination: string,
    readonly quota: bigint,
    private readonly replace: Publish = publish,
  ) {
    need(quota > 0n && quota <= MAX_ARCHIVE * 2n, 'Target quota');
  }
  async save(project: Project, signal: AbortSignal): Promise<Outcome> {
    need(
      !this.busy && !this.used.has(project.operationId) && this.used.size < 1024,
      'Busy/reused operation',
    );
    this.busy = true;
    let stage: string | undefined, handle: Awaited<ReturnType<typeof open>> | undefined;
    let attempt: NonNullable<FileTarget['pending']> | undefined;
    try {
      signal.throwIfAborted();
      const entries = await prepareProject(project, signal),
        expected = archiveSize(entries);
      let previous = 0n;
      try {
        const stat = await lstat(this.destination, { bigint: true });
        need(stat.isFile(), 'Destination regular file');
        previous = stat.size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      need(previous + expected <= this.quota, 'Quota before staging');
      signal.throwIfAborted();
      const candidate = join(dirname(this.destination), `.video-stage-${randomUUID()}`);
      handle = await open(candidate, 'wx+', 0o600);
      stage = candidate; // Cleanup owns this path only after exclusive creation succeeds.
      let written = 0n;
      const sink: Sink = {
        write: async (bytes, abort) => {
          abort.throwIfAborted();
          need(
            bytes.length <= CHUNK &&
              written + BigInt(bytes.length) <= expected &&
              previous + written + BigInt(bytes.length) <= this.quota,
            'Write quota',
          );
          let offset = 0;
          while (offset < bytes.length) {
            abort.throwIfAborted();
            const result = await handle!.write(
              bytes,
              offset,
              bytes.length - offset,
              Number(written),
            );
            need(result.bytesWritten > 0, 'Short write');
            offset += result.bytesWritten;
            written += BigInt(result.bytesWritten);
          }
        },
      };
      await writeZip(entries, sink, signal);
      need(written === expected, 'Archive length');
      await handle.sync();
      const reader = handleReader(handle, written);
      const opened = await openProject(reader, signal),
        digest = await scan(reader, signal);
      const receipt: Receipt = {
        operationId: opened.operationId,
        capture: opened.capture,
        sha256: digest.sha256,
        bytes: written.toString(),
      };
      await handle.close();
      handle = undefined;
      signal.throwIfAborted();
      // No cancellation after this boundary can prove that rename did not happen.
      this.used.add(receipt.operationId);
      attempt = { receipt, stage, publishing: true };
      this.pending = attempt;
      await this.replace(stage, this.destination);
      attempt.publishing = false;
      if (this.pending === attempt) {
        this.pending = undefined;
        this.busy = false;
      }
      return { state: 'saved', receipt: structuredClone(attempt.receipt) };
    } catch (e) {
      if (attempt) {
        attempt.publishing = false;
        return { state: 'unknown', receipt: structuredClone(attempt.receipt) };
      }
      const cleanup = await Promise.allSettled([
        handle?.close(),
        stage ? unlink(stage) : Promise.resolve(),
      ]);
      if (cleanup.some((result) => result.status === 'rejected')) {
        // Keep the target locked if staging occupancy cannot be released.
        throw new Error('Stage cleanup unresolved; Host recovery required');
      }
      this.busy = false;
      return { state: 'not-written', reason: String(e) };
    }
  }
  reconcile(operationId: string): Promise<Outcome> {
    need(this.pending && this.pending.receipt.operationId === operationId, 'Unknown operation');
    // A visible renamed file does not mean the owning replace promise has settled.
    // Keep its claim until save returns; late acknowledgement cannot touch a newer save.
    if (this.pending.publishing)
      return Promise.resolve({ state: 'unknown', receipt: structuredClone(this.pending.receipt) });
    if (this.reconciliation) return this.reconciliation;
    const owned = this.pending;
    let completed = false;
    // Register before asynchronous execution; concurrent inspect cannot republish an older save.
    this.reconciliation = Promise.resolve()
      .then(async (): Promise<Outcome> => {
        const pending = this.pending!;
        const unknown: Outcome = { state: 'unknown', receipt: structuredClone(pending.receipt) };
        let reader: Awaited<ReturnType<typeof fileReader>> | undefined;
        try {
          reader = await fileReader(this.destination);
          const signal = new AbortController().signal;
          const p = await openProject(reader, signal),
            digest = await scan(reader, signal);
          if (
            p.operationId !== operationId ||
            canonicalJson(p.capture) !== canonicalJson(pending.receipt.capture) ||
            digest.sha256 !== pending.receipt.sha256 ||
            reader.size.toString() !== pending.receipt.bytes
          )
            return unknown;
          // Best-effort cleanup of an unused staging path; never unlink the destination.
          await unlink(pending.stage).catch(() => {});
          if (this.pending !== pending) return unknown;
          await reader.close();
          reader = undefined;
          completed = true;
          return { state: 'saved', receipt: structuredClone(pending.receipt) };
        } catch {
          return unknown;
        } finally {
          await reader?.close();
        }
      })
      .finally(() => {
        this.reconciliation = undefined;
        if (completed && this.pending === owned) {
          this.pending = undefined;
          this.busy = false;
        }
      });
    return this.reconciliation;
  }
}
