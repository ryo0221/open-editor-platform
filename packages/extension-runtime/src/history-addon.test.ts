import { describe, expect, it } from 'vitest';
import { counterExtension } from '@editor-platform/extension-sample';
import { CREATE_ADDON, HISTORY_ADDON } from '@editor-platform/extension-contract';
import { parseManifest } from './index';

const hash = `sha256:${'4'.repeat(64)}`;
const base = counterExtension(hash).manifest;

describe('history@0-draft manifest (#64)', () => {
  it('accepts the exact token with keepHighest places, alone or beside other add-ons, frozen', () => {
    const m = parseManifest({
      ...base,
      addons: { history: { version: HISTORY_ADDON, keepHighest: ['/lastIssued'] } },
    });
    expect(m.addons).toEqual({
      history: { version: 'history@0-draft', keepHighest: ['/lastIssued'] },
    });
    expect(Object.isFrozen(m.addons!.history!.keepHighest)).toBe(true);
    const both = parseManifest({
      ...base,
      addons: {
        create: { version: CREATE_ADDON },
        history: { version: HISTORY_ADDON, keepHighest: ['/a', '/b/c'] },
      },
    });
    expect(Object.keys(both.addons!).sort()).toEqual(['create', 'history']);
  });

  it('refuses unknown versions, extra fields, other shapes and invalid places', () => {
    for (const history of [
      { version: 'history@1', keepHighest: ['/a'] },
      { version: HISTORY_ADDON, keepHighest: ['/a'], other: 1 },
      HISTORY_ADDON,
      null,
    ])
      expect(() => parseManifest({ ...base, addons: { history } })).toThrow(
        'Unsupported history add-on',
      );
    for (const keepHighest of [[], ['a'], ['/a', '/a'], 'a', undefined])
      expect(() =>
        parseManifest({ ...base, addons: { history: { version: HISTORY_ADDON, keepHighest } } }),
      ).toThrow('Invalid history add-on');
  });
});
