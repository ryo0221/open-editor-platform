import { useEffect, useRef, useState } from 'react';
import type {
  Domain,
  TemplateCatalog,
  TemplateDefinition,
  TemplateKind,
} from '@editor-platform/templates';

/** Focuses the first error notice below the sticky dialog heading whenever it changes. */
export function useErrorReveal(error: string) {
  const errorNotice = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!error) return;
    // The dialog heading is sticky. Reveal the first notice below it, including
    // after an apply at the bottom of a long preview, and announce keyboard focus.
    errorNotice.current?.focus({ preventScroll: true });
    errorNotice.current?.closest('dialog')?.scrollTo({ top: 0 });
  }, [error]);
  return errorNotice;
}

/** Lists catalog templates for the current filters; `reload` refreshes after an import. */
export function useTemplateItems(options: {
  catalog: TemplateCatalog;
  kind: TemplateKind;
  domain: Domain | '';
  query: string;
  category: string;
  setError(message: string): void;
}) {
  const { catalog, kind, domain, query, category, setError } = options;
  const [items, setItems] = useState<TemplateDefinition[]>([]);
  const reload = () =>
    catalog
      .list({ kind, domain: domain || undefined, search: query, category: category || undefined })
      .then(setItems)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    let active = true;
    void catalog
      .list({ kind, domain: domain || undefined, search: query, category: category || undefined })
      .then((values) => {
        if (active) setItems(values);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [catalog, domain, query, category, kind]);
  return { items, reload };
}
