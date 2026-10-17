/** Actual accepted AAC implementation. Observers wrap calls without replacing codec arithmetic/queue. */
import {
  AudioSample,
  AudioSampleResource,
  AudioSampleSource,
  Output,
  Mp4OutputFormat,
  BufferTarget,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import {
  beginEncoding,
  closeOwnedEncoders,
  endEncoding,
} from '../../../video-metadata/host-media/encoder-state.mjs';
import { correctMetadata } from '../../../video-metadata/host-media/encoder-timing.mjs';
import { Ledger } from '../pcm-wasm-r0/kernel';
registerAacEncoder();
const need = (ok, message) => {
  if (!ok) throw Error(message);
};
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const hash = async (bytes) =>
  Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
const watched = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: String(error) }),
  );
globalThis.actualAacCase = async function ({ mode = 'resource', count = 1024, fault = 'none' }) {
  need(['buffer', 'resource'].includes(mode), 'Unknown fixture mode');
  need([1000, 1024].includes(count), 'Unsupported short audio-only fixture');
  need(
    ['none', 'abort-after-post', 'close-after-post', 'post-throw'].includes(fault),
    'Unknown fault',
  );
  const realm = new Ledger(8 * 1024 * 1024),
    controller = new globalThis.AbortController();
  let peak = 0,
    callerBytes = 0,
    hashBytes = 0,
    releases = 0,
    expectedReleases = 0;
  const reserve = (n, category) => {
    const done = realm.reserve(n);
    peak = Math.max(peak, realm.bytes);
    if (category === 'input') callerBytes += n;
    else hashBytes += n;
    let live = true;
    return () => {
      if (live) {
        live = false;
        done();
        if (category === 'input') {
          callerBytes -= n;
          releases++;
        } else hashBytes -= n;
      }
    };
  };
  const state = beginEncoding(count),
    commands = [],
    samples = [],
    workerObserved = [],
    cleanup = [];
  let pendingCodecTransfer = 0,
    codecTransferPeak = 0,
    codecIncomingPeak = 0,
    codecPendingPeak = 0;
  let abortedWhileOwned = false,
    closeIssued = false,
    beforePostFailed = false;
  const addEncoder = state.encoders.add.bind(state.encoders);
  state.encoders.add = (instance) => {
    addEncoder(instance);
    codecPendingPeak = Math.max(codecPendingPeak, instance.pendingBuffer.byteLength);
    const encode = instance.encode;
    instance.encode = function (sample) {
      codecIncomingPeak = Math.max(
        codecIncomingPeak,
        sample.allocationSize({ format: 'f32', planeIndex: 0 }),
      );
      const work = encode.call(this, sample); // Return the original promise; no queue/algorithm replacement.
      void work.then(
        () => {
          codecPendingPeak = Math.max(codecPendingPeak, this.pendingBuffer.byteLength);
        },
        () => {},
      );
      return work;
    };
    const send = instance.sendCommand;
    instance.sendCommand = function (command, transfers) {
      const frame = command.type === 'encode' ? command.data.audioData : undefined;
      const size = frame?.byteLength ?? 0;
      const record = {
        type: command.type,
        bytes: size,
        inputOwnedAtSend: callerBytes,
        handed: false,
        state: 'pending',
      };
      commands.push(record);
      if (size) {
        pendingCodecTransfer += size;
        codecTransferPeak = Math.max(codecTransferPeak, pendingCodecTransfer);
      }
      if (fault === 'post-throw' && size && !beforePostFailed) {
        beforePostFailed = true;
        const post = this.worker.postMessage;
        this.worker.postMessage = function () {
          throw Error('Fixture postMessage pre-handoff failure');
        };
        const work = send.call(this, command, transfers);
        this.worker.postMessage = post;
        void work.then(
          () => {},
          () => {
            record.state = 'rejected-before-handoff';
            need(frame.byteLength === size, 'Unexpected transfer on rejected pre-handoff');
            pendingCodecTransfer -= size;
          },
        );
        return work;
      }
      const work = send.call(this, command, transfers);
      if (size) {
        record.handed = frame.byteLength === 0;
        need(record.handed, 'Actual worker input was not transferred');
      }
      void work.then(
        (result) => {
          record.state = 'ack';
          if (size) pendingCodecTransfer -= size;
          if (command.type === 'init')
            workerObserved.push({
              frameSize: result.frameSize,
              pendingBufferBytes: this.pendingBuffer.byteLength,
            });
        },
        () => {
          record.state = 'rejected-unproven';
        },
      ); // A rejected command is not a worker-input drain proof.
      if (size && (fault === 'abort-after-post' || fault === 'close-after-post') && !closeIssued) {
        closeIssued = true;
        abortedWhileOwned = callerBytes > 0;
        if (fault === 'abort-after-post')
          controller.abort(Error('Fixture abort during actual AAC command'));
        closeOwnedEncoders(state);
      }
      return work;
    };
    return state.encoders;
  };
  const target = new BufferTarget(),
    output = new Output({ format: new Mp4OutputFormat(), target }),
    audio = new AudioSampleSource({ codec: 'aac', bitrate: 192000 });
  output.addAudioTrack(audio);
  let failure, corrected;
  const actualAdds = [],
    inputDrains = [],
    referenceReleases = [];
  try {
    await output.start();
    for (let first = 0; first < count; first += 400) {
      controller.signal.throwIfAborted();
      const n = Math.min(400, count - first);
      const release = reserve(n * 4, 'input');
      expectedReleases++;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = (((first + i) % 97) - 48) / 320;
      const digestRelease = reserve(n * 4, 'hash');
      const digestCopy = pcm.slice();
      let inputHash;
      try {
        inputHash = await hash(digestCopy);
      } finally {
        digestRelease();
      }
      const done = defer();
      let resourceClose = 0;
      class OwnedResource extends AudioSampleResource {
        getFormat() {
          return 'f32';
        }
        getSampleRate() {
          return 48000;
        }
        getNumberOfFrames() {
          return n;
        }
        getNumberOfChannels() {
          return 1;
        }
        getTimestamp() {
          return first / 48000;
        }
        getDataPlane(index) {
          need(index === 0 && resourceClose === 0, 'Resource plane must remain owned');
          return new Uint8Array(pcm.buffer);
        }
        close() {
          resourceClose++;
          release();
          done.resolve();
        }
      }
      const sample =
        mode === 'resource'
          ? new AudioSample(new OwnedResource())
          : new AudioSample({
              data: pcm,
              format: 'f32',
              numberOfChannels: 1,
              sampleRate: 48000,
              timestamp: first / 48000,
            });
      if (mode === 'buffer') referenceReleases.push(release); // Baseline retains input to final teardown, independent of seam proof.
      const entry = {
        first,
        end: first + n,
        inputHash,
        callerClosed: false,
        resourceClose: 0,
        addSettled: false,
        commandsBefore: commands.length,
      };
      samples.push(entry);
      const add = audio.add(sample);
      actualAdds.push(watched(add));
      const actual = add.finally(() => {
        entry.addSettled = true;
        sample.close();
        entry.callerClosed = true;
      });
      const settled = await watched(actual);
      if (mode === 'resource') {
        inputDrains.push(done.promise);
        await done.promise;
        entry.resourceClose = resourceClose;
        need(resourceClose === 1, 'Last alias must close once');
        need(entry.addSettled, 'Caller closed before actual add');
      }
      if (!settled.ok) throw Error(settled.error);
      controller.signal.throwIfAborted();
      entry.inputDrainedBeforeFinalization = mode === 'resource';
    }
    await output.finalize();
    corrected = correctMetadata(target.buffer, {
      rate: 48000,
      count,
      origin: 0,
      rawPackets: state.rawPackets,
    });
  } catch (error) {
    failure = String(error);
  } finally {
    const close = async () => {
      try {
        closeOwnedEncoders(state);
      } catch (error) {
        cleanup.push(String(error));
      }
    };
    await close();
    try {
      await output.cancel();
    } catch (error) {
      cleanup.push(String(error));
    }
    await Promise.allSettled(actualAdds);
    await Promise.allSettled(inputDrains);
    await close();
    referenceReleases.forEach((release) => release());
    endEncoding(state);
  }
  need(realm.bytes === 0, 'Host-managed PCM did not drain');
  need(releases === expectedReleases, 'Input release count');
  if (fault === 'none') {
    need(
      !failure && !cleanup.length,
      'Normal AAC completion failed: ' + failure + ' ' + cleanup.join(';'),
    );
    need(
      commands.some((x) => x.type === 'encode' && x.state === 'ack' && x.handed),
      'No real worker encode acknowledgment',
    );
    need(
      commands.some((x) => x.type === 'flush' && x.state === 'ack'),
      'No real worker flush acknowledgment',
    );
    need(pendingCodecTransfer === 0, 'Acknowledged codec inputs still owned');
  } else {
    need(failure, 'Injected lifecycle fault did not fail');
    if (fault !== 'post-throw') {
      need(abortedWhileOwned, 'Close did not overlap owned input');
      need(pendingCodecTransfer > 0, 'Unproven worker input silently released');
    } else {
      need(beforePostFailed, 'Pre-handoff injection was not reached');
      need(
        commands.some(
          (x) =>
            x.type === 'encode' &&
            x.state === 'rejected-before-handoff' &&
            x.handed === false &&
            x.bytes === 4096,
        ),
        'Missing rejected pre-handoff 1024-frame mono f32 encode',
      );
      need(
        failure === 'Error: Fixture postMessage pre-handoff failure',
        'Expected the injected pre-handoff error, received: ' + failure,
      );
      need(pendingCodecTransfer === 0, 'Pre-handoff input did not drain');
    }
  }
  return {
    mode,
    count,
    fault,
    status: 'PASS',
    failure,
    cleanup,
    peakManagedBytes: peak,
    remainingManagedBytes: realm.bytes,
    callerBytes,
    hashBytes,
    releases,
    expectedReleases,
    samples,
    commands,
    workerObserved,
    codec: {
      scope: 'separate accepted codec-owned internals; not charged to managedPCM ledger',
      incomingCopyPeak: codecIncomingPeak,
      pendingBufferObservedPeak: codecPendingPeak,
      transferPeak: codecTransferPeak,
      unprovenTransferBytes: pendingCodecTransfer,
      heapInitialBytes: 18087936,
      heapMaximumGrowthBytes: 2147483648,
      nativeSuballocations: 'inside codec heap; not double counted',
      terminationAck: false,
    },
    timing: corrected?.evidence,
    bytes: corrected ? Array.from(new Uint8Array(corrected.buffer)) : undefined,
  };
};
