import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { validTasks, columns } from './samples';
/** One deterministic migration; preserve task identity and keep only native Data records. */
export function migrateTasks(tasks: unknown): StructuredData {
  if (!validTasks(tasks)) throw Error('旧Kanbanデータが不正です。元データは保持しています。');
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'title', name: 'タイトル', type: 'text', required: true, defaultValue: '新しいタスク' },
      {
        id: 'status',
        name: '状態',
        type: 'select',
        options: columns.map((c) => c.id),
        defaultValue: 'todo',
      },
      { id: 'description', name: '詳細', type: 'text' },
      { id: 'tag', name: 'タグ', type: 'text' },
      { id: 'owner', name: '担当', type: 'text' },
      {
        id: 'priority',
        name: '優先度',
        type: 'select',
        options: ['高', '中', '低'],
        defaultValue: '中',
      },
    ],
    rows: tasks.map(({ id, ...values }) => ({ id, values })),
  };
  const view = defaultView(data);
  data.views = [
    {
      ...view,
      id: 'sora-kanban',
      name: 'Kanban',
      projection: 'Kanban',
      groupBy: 'status',
      cardFields: ['title', 'description', 'tag', 'owner', 'priority'],
    },
    { ...view, id: 'sora-grid', name: 'Grid', projection: 'Grid' },
  ];
  if (!isStructuredData(data))
    throw Error('Dataへの移行を検証できませんでした。旧データは保持しています。');
  return data;
}
