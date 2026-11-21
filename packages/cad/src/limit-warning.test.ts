import { describe, expect, it } from 'vitest';
import { cadLimits, f01Empty } from '@editor-platform/cad-core';
import { limitWarningText } from './limit-warning';

describe('limit warning in the status line (#14)', () => {
  it('says nothing well within the limits', () => {
    expect(limitWarningText(f01Empty())).toBeUndefined();
  });

  it('names the limits near or over and how to split the model', () => {
    const features = Array.from(
      { length: cadLimits.features - 10 },
      (_, i) => ({ id: `f${i}`, type: 'box', args: {} }) as never,
    );
    expect(limitWarningText({ ...f01Empty(), features })).toBe(
      'Near the limit: features 2,038 / 2,048. Before it is reached, split the model into part versions and an assembly.',
    );
    const profiles = Array.from({ length: cadLimits.profiles + 1 }, () => ({}) as never);
    expect(limitWarningText({ ...f01Empty(), features, profiles })).toMatch(
      /^Over the limit: profiles 513 \/ 512, features 2,038 \/ 2,048\./,
    );
  });
});
