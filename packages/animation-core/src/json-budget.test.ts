import { expect, it } from 'vitest';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { JsonBudget } from './json-budget';
import { ownJson } from './validate';
import { prepareWithBudget } from './prepare';
import { animationFixture } from './fixtures';
import { evaluateAnimation, prepareAnimation, type RetainedSource, type SourceRef } from './index';

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

it.each([
  null,
  true,
  false,
  0,
  -0,
  -2.5,
  1e30,
  'plain',
  '日本語',
  '😀',
  '\ud800',
  '\udc00',
  '\u0000\b\t\n\f\r"\\',
  ['日本語', 2, null],
  { '😀\n': ['\ud800', true], a: {} },
])('accounts exact JSON UTF-8 bytes while copying %j', (value) => {
  const bytes = jsonBytes(value),
    budget = new JsonBudget(bytes);
  expect(ownJson(value, budget)).toEqual(value);
  expect(budget.bytesRemaining).toBe(0);
  expect(() => ownJson(value, new JsonBudget(bytes - 1))).toThrow('byte-limit');
});

it('uses a cumulative node budget across copies', () => {
  const budget = new JsonBudget(100, 3);
  expect(ownJson([1], budget)).toEqual([1]);
  expect(() => ownJson([2], budget)).toThrow('input-limit');
});

it('rejects during retained source copy before reading subsequent source or hashing, without mutating inputs', async () => {
  const root = animationFixture(),
    child = animationFixture();
  const ref: SourceRef = {
    artifactId: 'a',
    versionId: 'v1',
    compositionId: 'root',
    contentHash: await contentHash(child),
  };
  const before = canonicalJson({ root, child, ref });
  let laterSourceRead = false;
  const later: RetainedSource = {
    get ref(): SourceRef {
      laterSourceRead = true;
      throw new Error('later source must not be read');
    },
    content: child,
  };
  // Each source fits individually; the first retained copy exceeds the aggregate by one byte.
  const limit = jsonBytes(root) + jsonBytes(ref) + jsonBytes(child) - 1;
  expect(jsonBytes(child)).toBeLessThan(limit);
  const budget = new JsonBudget(limit);
  await expect(
    prepareWithBudget(root, [{ ref, content: child }, later], [], budget),
  ).rejects.toThrow('byte-limit');
  expect(laterSourceRead).toBe(false);
  expect(budget.bytesRemaining).toBeGreaterThanOrEqual(0);
  expect(canonicalJson({ root, child, ref })).toBe(before);
  // The exact small threshold accepts the same canonical source and evaluates identically.
  const exact = await prepareWithBudget(
    root,
    [{ ref, content: child }],
    [],
    new JsonBudget(limit + 1),
  );
  const normal = await prepareAnimation(root, [{ ref, content: child }]);
  expect(exact.contentHash).toBe(await contentHash(root));
  expect(evaluateAnimation(exact, 'root', 120000)).toEqual(
    evaluateAnimation(normal, 'root', 120000),
  );
  expect(canonicalJson({ root, child, ref })).toBe(before);
});
