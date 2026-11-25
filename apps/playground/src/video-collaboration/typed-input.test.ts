import { expect, it } from 'vitest';
import { editedCharacters } from './typed-input';

it('recovers only the remaining typed characters after replacements, insertions and deletions', () => {
  let value = '共同字幕';
  let mask: boolean[] = [];
  for (const next of ['共同の字幕', 'A共同の字幕', 'A共同字幕', 'A共同字幕。']) {
    mask = editedCharacters(value, next, mask);
    value = next;
  }
  expect(
    value
      .split('')
      .filter((_, i) => mask[i])
      .join(''),
  ).toBe('A。');
});
