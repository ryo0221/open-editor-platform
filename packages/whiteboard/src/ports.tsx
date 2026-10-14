import { CommitInput } from '@editor-platform/editor-ui';
import type { WhiteboardPort } from './model';

/** Native node settings shared by the normal inspector and Library revision form. */
export function WhiteboardPortsEditor(props: {
  ports?: WhiteboardPort[];
  used?: string[];
  onChange(ports: WhiteboardPort[]): void;
}) {
  const ports = props.ports ?? [];
  const patch = (key: string, value: Partial<WhiteboardPort>) =>
    props.onChange(ports.map((p) => (p.key === key ? { ...p, ...value } : p)));
  return (
    <fieldset>
      <legend>接続port</legend>
      {ports.map((port) => (
        <div key={port.key}>
          <CommitInput
            label={`port名: ${port.key}`}
            value={port.label}
            onCommit={(label) => patch(port.key, { label: label.slice(0, 200) })}
          />
          <label>
            portの辺: {port.label}
            <select
              value={port.side}
              onChange={(e) => patch(port.key, { side: e.target.value as WhiteboardPort['side'] })}
            >
              {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                <option key={side}>{side}</option>
              ))}
            </select>
          </label>
          <CommitInput
            label={`portの位置 (0–1): ${port.label}`}
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={port.offset}
            onCommit={(value) => {
              const offset = Number(value);
              if (Number.isFinite(offset) && offset >= 0 && offset <= 1)
                patch(port.key, { offset });
            }}
          />
          <button
            disabled={props.used?.includes(port.key)}
            onClick={() => props.onChange(ports.filter((p) => p.key !== port.key))}
          >
            portを削除: {port.label}
          </button>
          {props.used?.includes(port.key) && (
            <p>この図の接続で使用中です。先に接続先を変更してください。</p>
          )}
        </div>
      ))}
      <button
        disabled={ports.length >= 64}
        onClick={() =>
          props.onChange([
            ...ports,
            { key: 'port_' + crypto.randomUUID(), label: '新しいport', side: 'right', offset: 0.5 },
          ])
        }
      >
        接続portを追加
      </button>
    </fieldset>
  );
}
