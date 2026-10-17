/** Actual ownedHash, controlled digest delay/failure; never relaxes reservation admission. */
import assert from 'node:assert/strict';
import console from 'node:console';
import { ConsumerOwner, m2PcmDiagnostics } from './owners';
import { ownedHash, addOwnedAudio } from './output.mjs';
function owner(limit) {
  const actual = new ConsumerOwner('digest-fixture', limit);
  return {
    get bytes() {
      return actual.evidence().bytes;
    },
    get peak() {
      return actual.evidence().peak;
    },
    reserve: (n) => actual.reserve(n, 'fixture'),
    close: () => actual.close(),
  };
}
const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
const digestDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto.subtle, 'digest');
const restoreDigest = () => {
  if (digestDescriptor) Object.defineProperty(globalThis.crypto.subtle, 'digest', digestDescriptor);
  else delete globalThis.crypto.subtle.digest;
};
const input = () => new Float32Array([0, -0, 0.25, -0.5]);
try {
  for (const exportPath of [false, true]) {
    const budget = owner(exportPath ? 79 : 63),
      release = budget.reserve(16),
      data = input();
    let copied = 0,
      digested = 0,
      added = 0;
    const slice = data.slice.bind(data);
    data.slice = (...args) => {
      copied++;
      return slice(...args);
    };
    globalThis.crypto.subtle.digest = () => {
      digested++;
      throw Error('Must refuse before digest');
    };
    const chunk = { first: 0, planes: [data], release };
    await assert.rejects(
      exportPath
        ? addOwnedAudio(
            {
              add() {
                added++;
              },
            },
            chunk,
            budget,
            () => {},
          )
        : ownedHash(chunk, budget),
      /admission/,
    );
    assert.equal(digested, 0);
    assert.equal(added, 0);
    assert.equal(copied, exportPath ? 1 : 0);
    assert.equal(budget.bytes, exportPath ? 0 : 16);
    release();
    budget.close();
    assert.equal(budget.bytes, 0);
    assert.equal(m2PcmDiagnostics().realmBytes, 0);
  }
  for (const fault of ['none', 'reject', 'conversion']) {
    const budget = owner(64),
      release = budget.reserve(16);
    let settle,
      entered = false,
      converted = 0;
    const gate = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    globalThis.crypto.subtle.digest = (algorithm, data) => {
      entered = true;
      assert.equal(budget.bytes, 64);
      return gate.then(() => nativeDigest(algorithm, data));
    };
    const originalFrom = Array.from;
    Array.from = function (value, ...rest) {
      if (value instanceof Uint8Array && value.byteLength === 32) {
        converted++;
        assert.equal(budget.bytes, 64, 'Digest reservation released before conversion');
        if (fault === 'conversion') throw Error('controlled conversion failure');
      }
      return originalFrom.call(this, value, ...rest);
    };
    try {
      let done = false;
      const work = ownedHash({ planes: [input()] }, budget);
      const result = work
        .then(
          (value) => ({ value }),
          (error) => ({ error: String(error) }),
        )
        .then((x) => {
          done = true;
          return x;
        });
      assert.equal(entered, true);
      assert.equal(done, false);
      assert.equal(budget.bytes, 64);
      const abort = new globalThis.AbortController();
      const cancelledWait = Promise.race([
        result,
        new Promise((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(Error('caller stopped')), {
            once: true,
          });
        }),
      ]);
      abort.abort();
      await assert.rejects(cancelledWait, /caller stopped/);
      assert.equal(done, false);
      budget.close();
      assert.equal(budget.bytes, 64, 'Stopped wait or owner close released pending digest');
      if (fault === 'reject') settle.reject(Error('controlled digest rejection'));
      else settle.resolve();
      const got = await result;
      if (fault === 'none') assert.match(got.value, /^[a-f0-9]{64}$/);
      else
        assert.match(
          got.error,
          fault === 'reject' ? /controlled digest rejection/ : /controlled conversion failure/,
        );
      assert.equal(converted, fault === 'reject' ? 0 : 1);
      assert.equal(budget.bytes, 16);
      assert.equal(budget.peak, 64);
    } finally {
      Array.from = originalFrom;
      release();
      budget.close();
    }
    assert.equal(budget.bytes, 0);
    assert.equal(m2PcmDiagnostics().realmBytes, 0);
  }
} finally {
  restoreDigest();
}
console.log(
  'PASS hash near-cap refusal 63/79, exact64 delayed digest, aborted waiter, digest rejection and conversion failure; reservations retained through conversion',
);
