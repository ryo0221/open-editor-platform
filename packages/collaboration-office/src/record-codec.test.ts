import { expect, it } from 'vitest';
import { records, createRecordEditorCodec } from '@editor-platform/collaboration-office/records';

it('loads the public records entry before the Host catalogue', () => {
  const valid = (value: unknown): value is { title: string } =>
    !!value && typeof value === 'object' && 'title' in value && typeof value.title === 'string';
  const codec = createRecordEditorCodec(records('analysis', valid, ['title'], {}));
  expect(codec.validate({ title: 'Analysis' })).toBe(true);
});
