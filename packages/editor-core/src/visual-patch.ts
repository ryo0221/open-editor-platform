import type { VisualStyle, TextStyle } from './drawing';

/** Inspector patches change only the requested properties of each selected item. */
export function patchVisualStyle<T extends VisualStyle>(item: T, patch: Partial<T>): T {
  if (!patch.typography) return { ...item, ...patch };
  const runKeys = [
    'fontFamily',
    'fontSize',
    'bold',
    'italic',
    'underline',
    'strike',
    'color',
    'letterSpacing',
  ];
  const runPatch = Object.fromEntries(
    Object.entries(patch.typography).filter(([key]) => runKeys.includes(key)),
  ) as Partial<TextStyle>;
  return {
    ...item,
    ...patch,
    typography: { ...item.typography, ...patch.typography },
    ...(item.runs && Object.keys(runPatch).length && patch.runs === undefined
      ? { runs: item.runs.map((run) => ({ ...run, style: { ...run.style, ...runPatch } })) }
      : {}),
  };
}
