import { newId } from '@editor-platform/artifact-core';
import { Section, T, useWording } from '@editor-platform/editor-ui';
import { type StructuredData } from './model';
import { type DataView } from './views';
import { Pick } from './view-fields';

type Patch = (patch: Partial<DataView>) => void;
type Filter = DataView['filters'][number];

function FilterRule({
  data,
  view,
  patch,
  f,
  i,
}: {
  data: StructuredData;
  view: DataView;
  patch: Patch;
  f: Filter;
  i: number;
}) {
  const t = useWording();
  const update = (next: Partial<Filter>) =>
    patch({ filters: view.filters.map((v) => (v.id === f.id ? { ...v, ...next } : v)) });
  return (
    <div className="ep-filter-rule">
      <Pick
        label={`Filter ${i + 1} field`}
        display={t('Filter {0} field', i + 1)}
        value={f.columnId}
        columns={data.columns}
        onChange={(columnId) => update({ columnId })}
      />
      <select
        aria-label={`Filter ${i + 1} operator`}
        value={f.operator}
        onChange={(e) => update({ operator: e.target.value as typeof f.operator })}
      >
        {['contains', 'equals', 'not-equals', 'greater', 'less', 'empty', 'not-empty'].map((op) => (
          <option key={op} value={op}>
            {t(op)}
          </option>
        ))}
      </select>
      <input
        aria-label={`Filter ${i + 1} value`}
        value={f.value}
        onChange={(e) => update({ value: e.target.value })}
      />
      <button onClick={() => patch({ filters: view.filters.filter((v) => v.id !== f.id) })}>
        {t('Remove filter {0}', i + 1)}
      </button>
    </div>
  );
}

function SortRule({
  data,
  view,
  patch,
  s,
  i,
}: {
  data: StructuredData;
  view: DataView;
  patch: Patch;
  s: DataView['sorts'][number];
  i: number;
}) {
  const t = useWording();
  return (
    <div className="ep-filter-rule">
      <Pick
        label={`Sort ${i + 1} field`}
        display={t('Sort {0} field', i + 1)}
        value={s.columnId}
        columns={data.columns}
        onChange={(columnId) =>
          patch({ sorts: view.sorts.map((v, j) => (j === i ? { ...v, columnId } : v)) })
        }
      />
      <select
        aria-label={`Sort ${i + 1} direction`}
        value={s.descending ? 'desc' : 'asc'}
        onChange={(e) =>
          patch({
            sorts: view.sorts.map((v, j) =>
              j === i ? { ...v, descending: e.target.value === 'desc' } : v,
            ),
          })
        }
      >
        <option value="asc">{t('Ascending')}</option>
        <option value="desc">{t('Descending')}</option>
      </select>
      <button onClick={() => patch({ sorts: view.sorts.filter((_, j) => j !== i) })}>
        {t('Remove sort {0}', i + 1)}
      </button>
    </div>
  );
}

export function QuerySection({
  data,
  view,
  patch,
}: {
  data: StructuredData;
  view: DataView;
  patch: Patch;
}) {
  const t = useWording();
  return (
    <>
      <Section title="Filter and sort">
        <label className="ep-field">
          <T>Match</T>
          <select
            aria-label="Filter combination"
            value={view.filterMode}
            onChange={(e) => patch({ filterMode: e.target.value as 'and' | 'or' })}
          >
            <option value="and">{t('All conditions (AND)')}</option>
            <option value="or">{t('Any condition (OR)')}</option>
          </select>
        </label>
        {view.filters.map((f, i) => (
          <FilterRule key={f.id} data={data} view={view} patch={patch} f={f} i={i} />
        ))}
        <button
          onClick={() =>
            patch({
              filters: [
                ...view.filters,
                {
                  id: newId('filter'),
                  columnId: data.columns[0]?.id ?? '',
                  operator: 'contains',
                  value: '',
                },
              ],
            })
          }
        >
          <T>Add filter</T>
        </button>
        {view.sorts.map((s, i) => (
          <SortRule key={i} data={data} view={view} patch={patch} s={s} i={i} />
        ))}
        <button
          onClick={() =>
            patch({
              sorts: [...view.sorts, { columnId: data.columns[0]?.id ?? '', descending: false }],
            })
          }
        >
          <T>Add sort</T>
        </button>
        <Pick
          label="Group field"
          value={view.groupBy}
          columns={data.columns}
          onChange={(groupBy) => patch({ groupBy })}
        />
        <button onClick={() => patch({ search: '', filters: [], sorts: [], groupBy: '' })}>
          <T>Clear filters and sort</T>
        </button>
      </Section>
    </>
  );
}
