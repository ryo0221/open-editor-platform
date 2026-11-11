import { describe, expect, it } from 'vitest';
import {
  prepareHostTextReplacement,
  readHostContent,
  readHostElement,
  readHostElementText,
} from '@editor-platform/editor-host';
import { createDesign, makeDesignElement } from './model';
import { designHostAdapter, designPagesHostAdapter } from '@editor-platform/design/native-host';
const content = () => {
  const c = createDesign();
  c.elements.push(
    { ...makeDesignElement('text'), id: 'label', text: 'before' },
    { ...makeDesignElement('rectangle'), id: 'shape' },
  );
  return c;
};
describe('Design native Host adapter', () => {
  it('changes only plain text and rejects stale text while preserving layout and unrelated elements', () => {
    const c = content(),
      command = prepareHostTextReplacement(designHostAdapter, c, {
        selector: 'label',
        before: 'before',
        after: 'after',
      });
    const next = command.apply(c);
    expect(readHostElementText(designHostAdapter, next, 'label')).toBe('after');
    expect(next.elements[0]).toEqual({ ...c.elements[0], text: 'after' });
    expect(next.elements[1]).toEqual(c.elements[1]);
    expect(c.elements[0].text).toBe('before');
    expect(() => command.apply(next)).toThrow('changed');
  });
  it('refuses rich, nontext and unpaginated page content instead of guessing capability', () => {
    const c = content();
    expect(readHostElement(designHostAdapter, c, 'missing')).toBeNull();
    expect(() => readHostElementText(designHostAdapter, c, 'shape')).toThrow();
    c.elements[0].runs = [{ text: 'before', style: { bold: true } }];
    expect(() => readHostElementText(designHostAdapter, c, 'label')).toThrow();
    expect(designPagesHostAdapter.validate(content())).toBe(false);
  });
});

it('keeps whole as a literal ID and distinguishes missing ambiguous and unsupported text', () => {
  const c = content();
  c.elements[0].id = 'whole';
  expect(readHostElement(designHostAdapter, c, 'whole')).toEqual(c.elements[0]);
  expect(readHostElementText(designHostAdapter, c, 'whole')).toBe('before');
  expect(readHostContent(designHostAdapter, c)).toEqual(c);
  expect(() => readHostElementText(designHostAdapter, c, 'absent')).toThrow('missing:');
  expect(() => readHostElementText(designHostAdapter, c, 'shape')).toThrow('unsupported:');
  c.elements.push({ ...c.elements[0] });
  expect(() => designHostAdapter.native!.text!.read(c, 'whole')).toThrow('ambiguous:');
});
