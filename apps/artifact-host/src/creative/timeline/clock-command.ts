import { canonicalJson } from '@editor-platform/artifact-core';
import { timelineCommand, type TimelineRowInput } from './commands';
export function setClockOffset(
  id: string,
  from: string,
  to: string,
  offset: number | undefined,
  expected?: TimelineRowInput,
) {
  const seen = expected ? structuredClone(expected) : undefined;
  return timelineCommand(
    'world',
    'timeline.set-clock-offset',
    offset === undefined ? '時計の換算を解除' : '時計の換算を変更',
    (d) => {
      const row = d.rows.find((r) => r.id === id);
      if (canonicalJson(row ?? null) !== canonicalJson(seen ?? null))
        throw Error('時計の換算が変わりました。再確認してください。');
      if (row && row.values['tl1.row'] !== 'clock-offset')
        throw Error('時計の換算だけを編集できます。');
      if (offset === undefined) {
        d.rows = d.rows.filter((r) => r.id !== id);
        return;
      }
      if (!from || !to || from === to || !Number.isSafeInteger(offset) || Math.abs(offset) > 1e9)
        throw Error('異なる時計と、範囲内の整数の日数を指定してください。');
      if (
        [from, to].some((c) => !d.rows.some((r) => r.id === c && r.values['tl1.row'] === 'clock'))
      )
        throw Error('この世界設定にある時計を選んでください。');
      const next = {
        id,
        values: {
          'tl1.row': 'clock-offset',
          'tl1.clock': from,
          'tl1.clock2': to,
          'tl1.offset.min': offset,
          'tl1.offset.max': offset,
        },
      };
      if (row) row.values = next.values;
      else d.rows.push(next);
    },
  );
}
