import type {
  Resources,
  ResourceBounds,
  ResourceIdentity,
  Scope,
} from '@editor-platform/extension-contract/draft2';
import {
  aborted,
  copyData,
  delivery,
  frozen,
  Ownership,
  requireThat,
  type Clock,
} from './primitives';
export interface RawLease<Ref> {
  identity: ResourceIdentity<Ref>;
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  release(): Promise<void>;
}
/** Trusted provider verifies immutable bytes and exact catalog membership before open. */
export interface ResourceProvider<Ref> {
  bounds: ResourceBounds;
  open(expected: ResourceIdentity<Ref>, signal: AbortSignal): Promise<RawLease<Ref>>;
}
export function createResources<Ref>(options: {
  scope: Scope;
  signal: AbortSignal;
  clock: Clock;
  ownership: Ownership;
  provider: ResourceProvider<Ref>;
  check(): void;
}): Resources<Ref> {
  return {
    version: 'resources@0-draft',
    async open(identity, requested, caller) {
      options.check();
      aborted(caller);
      const expected = frozen(identity);
      requireThat(
        /^[a-f0-9]{64}$/.test(expected.sha256) &&
          Number.isSafeInteger(expected.byteLength) &&
          expected.byteLength >= 0,
        'ResourceIdentity',
      );
      const bounds = copyData(requested);
      for (const name of [
        'maxReadBytes',
        'maxTotalBytes',
        'maxReads',
        'maxPendingReads',
      ] as const) {
        requireThat(
          Number.isSafeInteger(bounds[name]) &&
            bounds[name] > 0 &&
            Number.isSafeInteger(options.provider.bounds[name]) &&
            options.provider.bounds[name] > 0,
          'ResourceBounds',
        );
        bounds[name] = Math.min(bounds[name], options.provider.bounds[name]);
      }
      const effective = frozen(bounds);
      const id = `lease:${crypto.randomUUID()}`;
      const hold = options.ownership.hold(id);
      const owned = new Ownership(options.scope, options.clock);
      const lifetime = owned.hold('allocation-and-release');
      const controller = new AbortController();
      let released = false;
      let raw: RawLease<Ref> | undefined;
      let closing: Promise<void> | undefined;
      const reads = new Set<Promise<unknown>>();
      let total = 0;
      let count = 0;
      const close = () => {
        if (closing) return closing;
        released = true;
        controller.abort();
        closing = (async () => {
          await allocation.catch(() => undefined);
          await Promise.allSettled([...reads]);
          if (raw) await raw.release();
        })();
        closing.then(
          () => {
            hold.done();
            lifetime.done();
            detach();
          },
          (error) => {
            hold.fail(String(error));
            lifetime.fail(String(error));
            detach();
          },
        );
        return closing;
      };
      const cancel = () => {
        void close();
      };
      // Allocation is already owned before invoking the async provider. Defer handoff one microtask.
      const allocation = Promise.resolve()
        .then(() => {
          options.check();
          aborted(caller);
          return options.provider.open(expected, controller.signal);
        })
        .then((value) => {
          raw = value;
          return value;
        });
      options.signal.addEventListener('abort', cancel, { once: true });
      caller?.addEventListener('abort', cancel, { once: true });
      const acquisition = async () => {
        try {
          const value = await allocation;
          options.check();
          aborted(caller);
          requireThat(!released, 'LeaseReleased');
          requireThat(
            JSON.stringify(value.identity) === JSON.stringify(expected),
            'ResourceIdentity',
          );
          return {
            identity: expected,
            bounds: effective,
            scope: options.scope,
            signal: controller.signal,
            async read(offset: number, length: number, signal?: AbortSignal) {
              options.check();
              aborted(caller);
              aborted(signal);
              requireThat(!released, 'LeaseReleased');
              requireThat(
                Number.isSafeInteger(offset) &&
                  offset >= 0 &&
                  Number.isSafeInteger(length) &&
                  length >= 0 &&
                  offset + length <= expected.byteLength,
                'ResourceRange',
              );
              requireThat(
                length <= effective.maxReadBytes &&
                  total + length <= effective.maxTotalBytes &&
                  count < effective.maxReads &&
                  reads.size < effective.maxPendingReads,
                'ResourceBudget',
              );
              total += length;
              count++;
              const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
              const readHold = owned.hold(`read:${count}`);
              const operation = Promise.resolve().then(() => {
                options.check();
                aborted(combined);
                return value.read(offset, length, combined);
              });
              reads.add(operation);
              operation.then(
                () => {
                  reads.delete(operation);
                  readHold.done();
                },
                () => {
                  reads.delete(operation);
                  readHold.done();
                },
              );
              const result = await delivery(operation, controller.signal, options.check);
              options.check();
              aborted(combined);
              requireThat(result instanceof Uint8Array && result.length === length, 'ShortRead');
              return result.slice();
            },
            async release(deadline: { deadlineMs: number }) {
              void close();
              owned.revoke();
              const report = await owned.drain(deadline);
              return report;
            },
          };
        } catch (error) {
          void close();
          throw error;
        }
      };
      const result = acquisition();
      // Event listeners are kept until confirmed release, including quarantine.
      const detach = () => {
        options.signal.removeEventListener('abort', cancel);
        caller?.removeEventListener('abort', cancel);
      };
      allocation.catch(() => {
        detach();
      });
      return delivery(result, options.signal, options.check);
    },
  };
}
