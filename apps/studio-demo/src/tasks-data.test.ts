import { expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { soraTasks } from './samples';
import { migrateTasks } from './tasks-data';
it('migrates old task arrays once into native Data records without changing identity or source', () => {
  const old = soraTasks(),
    before = canonicalJson(old),
    data = migrateTasks(old);
  expect(data.rows.map((r) => r.id)).toEqual(old.map((t) => t.id));
  expect(data.rows.map((r) => r.values)).toEqual(old.map(({ id: _id, ...values }) => values));
  expect(data.views?.map((v) => v.projection)).toEqual(['Kanban', 'Grid']);
  expect(canonicalJson(old)).toBe(before);
  expect(() => migrateTasks([{ ...old[0], status: 'invalid' }])).toThrow();
});
