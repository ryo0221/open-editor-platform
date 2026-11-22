import { CommitInput, useWording } from '@editor-platform/editor-ui';
import type { WhiteboardPort } from './model';

/** Native node settings shared by the normal inspector and Library revision form. */
export function WhiteboardPortsEditor(props: {
  ports?: WhiteboardPort[];
  used?: string[];
  onChange(ports: WhiteboardPort[]): void;
}) {
  const t = useWording();
  const ports = props.ports ?? [];
  const patch = (key: string, value: Partial<WhiteboardPort>) =>
    props.onChange(ports.map((p) => (p.key === key ? { ...p, ...value } : p)));
  return (
    <fieldset>
      <legend>{t('接続port')}</legend>
      {ports.map((port) => (
        <div key={port.key}>
          <CommitInput
            label={t('port名: {0}', port.key)}
            value={port.label}
            onCommit={(label) => patch(port.key, { label: label.slice(0, 200) })}
          />
          <label>
            {t('portの辺: {0}', port.label)}
            <select
              value={port.side}
              onChange={(e) => patch(port.key, { side: e.target.value as WhiteboardPort['side'] })}
            >
              {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                <option key={side} value={side}>
                  {t(side)}
                </option>
              ))}
            </select>
          </label>
          <CommitInput
            label={t('portの位置 (0–1): {0}', port.label)}
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
            {t('portを削除: {0}', port.label)}
          </button>
          {props.used?.includes(port.key) && (
            <p>{t('この図の接続で使用中です。先に接続先を変更してください。')}</p>
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
        {t('接続portを追加')}
      </button>
    </fieldset>
  );
}
