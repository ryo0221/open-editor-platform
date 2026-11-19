import { describe, expect, it } from 'vitest';
import { noteEms } from './sketch-note-width';

describe('noteEms (CLF10)', () => {
  it('takes a full-width glyph about 1 em and a Latin one less', () => {
    const latin = noteEms('Roof');
    const japanese = noteEms('屋根の線');
    expect(latin).toBeGreaterThan(1.5);
    expect(latin).toBeLessThan(3.5);
    expect(japanese).toBeGreaterThan(3.5);
    expect(japanese).toBeLessThan(4.5);
  });
});
