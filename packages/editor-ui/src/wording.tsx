import { createContext, useContext, useMemo, type ReactNode } from 'react';

/** Display language of a Surface's visible wording. */
export type EditorLocale = 'ja' | 'en';

/**
 * A wording dictionary: the text written in the source is the key and the text to show is the
 * value. A text without an entry is shown as written, so a term that reads better untranslated
 * simply has no entry.
 */
export type EditorWording = Readonly<Record<string, string>>;

/** One dictionary per locale. A package exports its own and a Surface joins the ones it shows. */
export type EditorWordingSet = Readonly<Partial<Record<EditorLocale, EditorWording>>>;

/**
 * Returns the text to show for a text written in the source. `{0}`, `{1}`… in the result are
 * replaced with `args`, so a sentence may order its parts as the language needs.
 */
export type Wording = (text: string, ...args: (string | number)[]) => string;

const fill = (text: string, args: (string | number)[]) =>
  args.length ? text.replace(/\{(\d+)\}/g, (all, i) => String(args[Number(i)] ?? all)) : text;

const asWritten: Wording = (text, ...args) => fill(text, args);

/**
 * Builds the lookup for a locale. Later sets win over earlier ones and `labels`, the Host's own
 * replacements, win over every set. Without a locale only `labels` apply.
 */
export function resolveWording(
  locale: EditorLocale | undefined,
  sets: readonly EditorWordingSet[],
  labels?: EditorWording,
): Wording {
  const entries = new Map<string, string>();
  if (locale)
    for (const set of sets)
      for (const [key, value] of Object.entries(set[locale] ?? {})) entries.set(key, value);
  for (const [key, value] of Object.entries(labels ?? {})) entries.set(key, value);
  if (!entries.size) return asWritten;
  return (text, ...args) => fill(entries.get(text) ?? text, args);
}

const WordingContext = createContext<Wording>(asWritten);

/**
 * Visible wording of the Surface below it. Accessible names given by `aria-label` are not looked
 * up here: they stay as written in the source, so assistive technology and tests keep stable
 * names while the visible text and tooltips follow the locale.
 */
export function EditorWordingProvider({
  locale,
  sets,
  labels,
  children,
}: {
  locale?: EditorLocale;
  sets: readonly EditorWordingSet[];
  labels?: EditorWording;
  children: ReactNode;
}) {
  const wording = useMemo(() => resolveWording(locale, sets, labels), [locale, sets, labels]);
  return <WordingContext.Provider value={wording}>{children}</WordingContext.Provider>;
}

export const useWording = (): Wording => useContext(WordingContext);

/** Props every Surface with localizable wording accepts. */
export interface EditorWordingProps {
  /** Language of the visible wording. Omitted: the wording as written in the source. */
  locale?: EditorLocale;
  /** Host replacements for visible wording, keyed by the text written in the source. */
  labels?: EditorWording;
}

/** Wording of the shared controls in this package. */
export const editorUiWording: EditorWordingSet = {
  ja: {
    Navigator: 'ナビゲーター',
    Inspector: 'インスペクター',
    'Toggle {0}': '{0}を開閉',
    'Close {0}': '{0}を閉じる',
    'Focus mode': '集中モード',
    'More editor tools': 'ほかの道具',
  },
};

/**
 * Visible text written between tags: `<T>Start date</T>` shows the wording for "Start date".
 * `args` fill `{0}`, `{1}`… of the wording.
 */
export function T({ children, args = [] }: { children: string; args?: (string | number)[] }) {
  return <>{useWording()(children, ...args)}</>;
}
