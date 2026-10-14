import { expect, it } from 'vitest';
import {
  createDesign,
  isDesign,
  makeDesignVector,
  validDesignVector,
} from '@editor-platform/design/model';
import { checkVector } from '../../../tests/fixtures/design-reuse/content';

it.each(['viewBox', 'provenance'] as const)(
  'rejects non-record and inherited %s fields before native save',
  (field) => {
    const record = checkVector[field];
    const badRecords = [
      Object.assign([], record),
      Object.create(record),
      Object.assign(new Date(), record),
    ];
    for (const key of Object.keys(record)) {
      const inherited: Record<string, unknown> = { ...record };
      Object.setPrototypeOf(inherited, { [key]: inherited[key] });
      delete inherited[key];
      badRecords.push(inherited);
    }
    for (const bad of badRecords) {
      const vector = { ...checkVector, [field]: bad };
      expect(validDesignVector(vector)).toBe(false);
      expect(() => makeDesignVector(vector)).toThrow(/Invalid/);
      expect(
        isDesign({ ...createDesign(), elements: [{ ...makeDesignVector(checkVector), vector }] }),
      ).toBe(false);
    }
  },
);

it('rejects inherited vector fields that would be lost during construction', () => {
  const vector = Object.create(checkVector);
  expect(validDesignVector(vector)).toBe(false);
  expect(() => makeDesignVector(vector)).toThrow(/Invalid/);
});

it('accepts own fields on null-prototype records and retains native JSON', () => {
  const vector = {
    ...checkVector,
    viewBox: Object.assign(Object.create(null), checkVector.viewBox),
    provenance: Object.assign(Object.create(null), checkVector.provenance),
  };
  expect(validDesignVector(vector)).toBe(true);
  const content = { ...createDesign(), elements: [makeDesignVector(vector)] };
  const restored = JSON.parse(JSON.stringify(content));
  expect(isDesign(restored)).toBe(true);
  expect(restored.elements[0].vector).toEqual(checkVector);
});
