import { T, useWording } from '@editor-platform/editor-ui';
import { chartPoints, chartSvg } from './charts';
import { type StructuredData, type DataRow } from './model';
import { type ChartConfig } from './views';
export function DataChart({
  data,
  rows,
  config,
  accent,
  width = 900,
  height = 430,
}: {
  data: StructuredData;
  rows: DataRow[];
  config: ChartConfig;
  accent?: string;
  width?: number;
  height?: number;
}) {
  const t = useWording();
  const points = chartPoints(data, rows, config);
  const total = points.reduce((sum, point) => sum + (point.value ?? 0), 0);
  return (
    <div className="ep-chart">
      <div
        dangerouslySetInnerHTML={{ __html: chartSvg(data, rows, config, width, height, accent) }}
      />
      <details>
        <summary>{t('Chart aggregate table / 集計表')}</summary>
        <table>
          <caption>
            {config.aggregate} · {t('{0} records', rows.length)} ·{' '}
            {data.columns.find((column) => column.id === config.x)?.name ?? t('All records')} /{' '}
            {data.columns.find((column) => column.id === config.y)?.name ?? t('Records')} ·{' '}
            {t(
              'series {0}',
              data.columns.find((column) => column.id === config.series)?.name ?? t('none'),
            )}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <T>Category</T>
              </th>
              <th scope="col">
                <T>Series</T>
              </th>
              <th scope="col">
                <T>Value</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point, index) => (
              <tr key={index}>
                <th scope="row">{point.label}</th>
                <td>{point.series || '—'}</td>
                <td>{point.value ?? '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                <T>Sum of displayed aggregates</T>
              </th>
              <td />
              <td>{total}</td>
            </tr>
          </tfoot>
        </table>
      </details>
    </div>
  );
}
