import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { parseTouchPinOptions } from '../extension-hosts/touch-pin-options.mjs';
const paths = ['consumer', 'second-path', 'third-path'];
const pin = 'a'.repeat(40),
  digest = 'b'.repeat(64);
const pair = ['--expected-pin', pin, '--expected-provenance', digest];
const modes = ['--dom-timing', '--dom-point-timing', '--product-paced'];

test('historical pair and positional paths remain unchanged', () => {
  assert.deepEqual(parseTouchPinOptions(paths), {
    paths,
    expectedPin: '082c698740cf30f78ec4f9a293e663633ba86f0a',
    expectedProvenance: '8ec2cef23877ac8e3810984fed598b2a0a2fa1b224501addf88926257cc10e66',
    mode: undefined,
  });
});
test('explicit pair works in either order and with every existing Video mode', () => {
  for (const mode of modes) {
    for (const options of [
      [mode, ...pair],
      [...pair, mode],
      ['--expected-provenance', digest, mode, '--expected-pin', pin],
    ])
      assert.deepEqual(parseTouchPinOptions([...paths, ...options], modes), {
        paths,
        expectedPin: pin,
        expectedProvenance: digest,
        mode,
      });
    assert.equal(parseTouchPinOptions([...paths, mode], modes).mode, mode);
  }
  assert.equal(parseTouchPinOptions([...paths, ...pair]).expectedPin, pin);
});
test('reject partial pairs, missing values, malformed digests and abbreviated pins', () => {
  for (const options of [
    pair.slice(0, 2),
    pair.slice(2),
    ['--expected-pin'],
    ['--expected-provenance'],
    ['--expected-pin', '082c6987', ...pair.slice(2)],
    ['--expected-pin', 'g'.repeat(40), ...pair.slice(2)],
    [...pair.slice(0, 2), '--expected-provenance', 'z'.repeat(64)],
    [...pair.slice(0, 2), '--expected-provenance', 'b'.repeat(63)],
    ['--expected-pin', '--expected-provenance', digest],
  ])
    assert.throws(() => parseTouchPinOptions([...paths, ...options]), /requires|together/);
});
test('reject duplicate, unknown, positional-after-path and conflicting mode options', () => {
  for (const options of [
    [...pair, ...pair],
    ['--typo'],
    ['extra-path'],
    ['--dom-timing', '--product-paced'],
    ['--dom-timing', '--dom-timing'],
  ])
    assert.throws(() => parseTouchPinOptions([...paths, ...options], modes));
  assert.throws(() => parseTouchPinOptions([...paths, '--dom-timing']), /Unknown/);
  assert.throws(() => parseTouchPinOptions(paths.slice(0, 2)), /three positional/);
  assert.throws(() => parseTouchPinOptions(['--expected-pin', pin, 'output']), /three positional/);
});
test('both executable entrypoints reject invalid trust flags before filesystem or browser work', () => {
  for (const script of [
    'packages/animation/tests/installed-touch.mjs',
    'scripts/extension-hosts/touch-video-check.mjs',
  ]) {
    for (const options of [
      ['--expected-pin', pin],
      ['--expected-provenance', 'invalid'],
      ['--unknown'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...paths, ...options], {
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /together|requires|Unknown option/);
      assert.doesNotMatch(result.stderr, /ENOENT|browserType.launch/);
    }
  }
});
