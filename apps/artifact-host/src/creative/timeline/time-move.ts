/** Move an explicitly positioned event without changing precision or breaking a derivation. */
import { setTime, TimelineEditError, type TimelineTimeInput } from './commands';
export function shiftEventTime(id: string, days: number, expected: TimelineTimeInput) {
  if (!Number.isSafeInteger(days) || days === 0)
    throw new TimelineEditError('移動日数を整数で指定してください。');
  if (expected.kind === 'unset' || expected.kind === 'derived')
    throw new TimelineEditError('未定・導出の時点はフォームで明示的に変更してください。');
  return setTime(
    id,
    {
      ...expected,
      ...(expected.start !== undefined ? { start: expected.start + days } : {}),
      ...(expected.end !== undefined ? { end: expected.end + days } : {}),
    },
    expected,
  );
}
