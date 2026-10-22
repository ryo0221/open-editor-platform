import { PropertyInput } from '@editor-platform/property-input';
import { displayCell, type StructuredData, type DataRow, type Column } from './model';
export function ValueInput({
  data,
  row,
  column,
  value,
  onChange,
  onKeyDown,
  onBlur,
  autoFocus = false,
  readOnly = false,
  label,
}: {
  data: StructuredData;
  row: DataRow;
  column: Column;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: React.KeyboardEventHandler<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >;
  onBlur?: () => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  label?: string;
}) {
  const labelText =
    label ?? `${column.name} · ${String(row.values[data.columns[0]?.id] ?? 'record')}`;
  if (column.type === 'formula')
    return <output aria-label={labelText}>{displayCell(data, row, column)}</output>;
  const options =
    column.type === 'boolean'
      ? ['true', 'false'].map((v) => ({ value: v, label: v }))
      : column.type === 'select'
        ? column.options?.map((v) => ({ value: v, label: v }))
        : column.type === 'relation'
          ? data.rows.map((r) => ({
              value: r.id,
              label: String(r.values[data.columns[0]?.id] ?? r.id),
            }))
          : undefined;
  return (
    <PropertyInput
      label={labelText}
      value={value}
      onChange={onChange}
      type={
        options
          ? 'select'
          : column.type === 'date'
            ? 'date'
            : column.type === 'number'
              ? 'number'
              : 'text'
      }
      options={options}
      readOnly={readOnly || column.readOnly}
      autoFocus={autoFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}
