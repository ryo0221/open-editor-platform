import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import inputs from './oracle-inputs.json';
it('keeps the independent whole renderer and complete used rational dependency frozen', () => {
  for (const file of inputs.files) {
    const bytes = readFileSync(new URL(file.frozen, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.frozenSha256);
  }
});
