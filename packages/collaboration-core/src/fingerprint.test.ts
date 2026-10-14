import { expect, it } from 'vitest';
import { canonical, fingerprint } from './contracts';

it('preserves the pre-optimization wire hash for lexical keys, Unicode and legacy special values', () => {
  const value = {
    10: '十',
    2: 'two',
    a: [undefined, null, NaN, Infinity, -0, '日本語 📝', '\ud800', '\n"\\'],
    z: { missing: undefined, b: 2, a: 1 },
  };
  expect(fingerprint(value)).toBe(
    '43aa16df1ddf2e33704647eb185090c41203cb8d4288231d9553ab9b3097918c',
  );
});

async function reference(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

it('keeps canonical wire fingerprints identical to independent WebCrypto SHA-256', async () => {
  const values = [
    undefined,
    null,
    false,
    true,
    0,
    -0,
    1,
    -42,
    1.25,
    NaN,
    Infinity,
    '',
    'null',
    '日本語 📝',
    [],
    [undefined, null, true],
    { z: 2, a: { width: 100, x: -2.5 }, absent: undefined },
    'Large asset '.repeat(2000),
  ];
  for (const value of values) {
    const expected = await reference(value);
    expect(fingerprint(value)).toBe(expected);
    expect(fingerprint(value)).toBe(expected);
  }
  expect(fingerprint({ second: 2, first: 1 })).toBe(fingerprint({ first: 1, second: 2 }));
});

it('rechecks mutable resource values and preserves hashes after bounded-cache eviction', async () => {
  const value = { bounds: { x: 0, y: 0, width: 100, height: 50 }, children: ['a'] };
  const before = fingerprint(value);
  value.bounds.x = 20;
  value.children.push('b');
  expect(fingerprint(value)).not.toBe(before);
  expect(fingerprint(value)).toBe(await reference(value));
  for (let i = 0; i < 1100; i++) fingerprint({ unique: i });
  value.bounds.x = 0;
  value.children.pop();
  expect(fingerprint(value)).toBe(before);
  expect(fingerprint(value)).toBe(await reference(value));
});
