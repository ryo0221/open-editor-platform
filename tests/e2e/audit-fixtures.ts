import { type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { type DocumentContent } from '@editor-platform/document/model';
export function auditData(): StructuredData {
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'title', name: 'Name', type: 'text' },
      { id: 'value', name: 'Value', type: 'number' },
      { id: 'state', name: 'State', type: 'select', options: ['Plan', 'Ready'] },
      { id: 'series', name: 'Team', type: 'text' },
      { id: 'start', name: 'Start', type: 'date' },
      { id: 'end', name: 'End', type: 'date' },
      { id: 'note', name: 'Note', type: 'text' },
      { id: 'ref', name: 'Related', type: 'relation' },
    ],
    rows: [
      {
        id: 'first',
        values: {
          title: 'First period',
          value: 40,
          state: 'Plan',
          series: 'Alpha',
          start: '2026-11-02',
          end: '2026-11-08',
          note: '日本語,"引用"',
          ref: null,
        },
      },
      {
        id: 'second',
        values: {
          title: 'Second period',
          value: 50,
          state: 'Plan',
          series: 'Beta',
          start: '2026-11-04',
          end: '2026-11-10',
          note: '改行\n本文',
          ref: 'first',
        },
      },
      {
        id: 'third',
        values: {
          title: 'Third period',
          value: 80,
          state: 'Ready',
          series: 'Alpha',
          start: '2026-11-06',
          end: '2026-11-12',
          note: 'hidden',
          ref: 'first',
        },
      },
    ],
  };
  const view = defaultView(data);
  view.name = 'Audit dashboard';
  view.projection = 'Dashboard';
  view.hidden = ['note'];
  view.timeline = {
    ...view.timeline,
    start: 'start',
    end: 'end',
    from: '2026-11-01',
    to: '2026-11-20',
  };
  view.chart = { ...view.chart, type: 'pie', x: 'state', y: 'value', series: 'series' };
  view.widgets = [
    { id: 'metric', type: 'metric', title: 'Total', columnId: 'value', aggregate: 'sum' },
    { id: 'chart', type: 'chart', title: 'Groups', chart: view.chart },
    { id: 'table', type: 'table', title: 'Rows' },
  ];
  data.views = [view];
  return data;
}
export function auditDocument(): DocumentContent {
  return {
    schemaVersion: 2,
    blocks: [
      { id: 'heading', type: 'heading', level: 1, text: '日本語の監査' },
      { id: 'body', type: 'paragraph', text: '検索してコピーする本文です。' },
      {
        id: 'table',
        type: 'table',
        text: '',
        cells: [
          ['項目', '金額'],
          ['活動', '12'],
        ],
      },
    ],
  };
}
