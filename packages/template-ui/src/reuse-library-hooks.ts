import { useEffect, useState } from 'react';
import { clone } from '@editor-platform/artifact-core';
import {
  refKey,
  type JsonValue,
  type LockedClosure,
  type ReuseInstance,
} from '@editor-platform/reuse-core';
import {
  retainedComponent,
  validateComponentDefinition,
  type ComponentSlotValue,
  type InputValue,
  type TemplateTarget,
  type CatalogAdapter,
  type ComponentDefinition,
  type Domain,
  type ReusableDraft,
  type TemplateCatalog,
} from '@editor-platform/templates';

/** Loads validated component definitions, archived keys and editable drafts for one domain. */
export function useReusableComponents(options: {
  catalog: TemplateCatalog;
  writeCatalog?: CatalogAdapter;
  domain: Domain;
  refresh: number;
  includeArchived: boolean;
  setError(message: string): void;
}) {
  const { catalog, writeCatalog, domain, refresh, includeArchived, setError } = options;
  const [items, setItems] = useState<ComponentDefinition[]>([]);
  const [drafts, setDrafts] = useState<ReusableDraft[]>([]),
    [archived, setArchived] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      catalog.listReusable({
        domain,
        kind: 'component',
        archived: includeArchived,
      }),
      catalog.listReusable({ domain, kind: 'component' }),
    ])
      .then(async ([values, active]) => {
        const checked = await Promise.all(values.map(validateComponentDefinition));
        if (!cancelled) {
          setItems(checked);
          setArchived(
            values.filter((d) => !active.some((a) => refKey(a) === refKey(d))).map(refKey),
          );
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, domain, refresh, includeArchived]);
  useEffect(() => {
    let cancelled = false;
    void writeCatalog
      ?.listReusableDrafts?.()
      .then((values) => {
        if (!cancelled)
          setDrafts(values.filter((d) => d.ref.domain === domain && d.ref.kind === 'component'));
      })
      .catch((error) => {
        if (!cancelled) setError((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [writeCatalog, domain, refresh]);
  return { items, drafts, archived };
}

export interface SlotDraft {
  slotId: string;
  slotText: string;
  slotComponent: string;
  setSlotId(value: string): void;
  setSlotText(value: string): void;
  setSlotComponent(value: string): void;
}

/** Holds the pending slot addition across instance selections. */
export function useSlotDraft(): SlotDraft {
  const [slotId, setSlotId] = useState(''),
    [slotText, setSlotText] = useState(''),
    [slotComponent, setSlotComponent] = useState('');
  return { slotId, slotText, slotComponent, setSlotId, setSlotText, setSlotComponent };
}

/** Selected component, its locked closure and the pending property/variant/mode inputs. */
export function useComponentSelection() {
  const [selected, setSelected] = useState<ComponentDefinition>(),
    [closure, setClosure] = useState<LockedClosure<unknown>>();
  const [instance, setInstance] = useState<ReuseInstance>();
  const [inputs, setInputs] = useState<Record<string, JsonValue>>({}),
    [variant, setVariant] = useState('');
  const [changed, setChanged] = useState<string[]>([]);
  const [mode, setMode] = useState('');
  const [modeChanged, setModeChanged] = useState(false),
    [variantChanged, setVariantChanged] = useState(false);
  const [initialSlots, setInitialSlots] = useState<Record<string, ComponentSlotValue[]>>({});
  const [dataTarget, setDataTarget] = useState<TemplateTarget>({});
  return {
    selected,
    setSelected,
    closure,
    instance,
    inputs,
    variant,
    changed,
    mode,
    modeChanged,
    variantChanged,
    initialSlots,
    setInitialSlots,
    dataTarget,
    setDataTarget,
    choose(
      definition: ComponentDefinition,
      closure: LockedClosure<unknown>,
      retained: ReturnType<typeof retainedComponent> | undefined,
      clear: () => void,
    ) {
      setSelected(definition);
      setInstance(retained?.instance);
      setClosure(closure);
      setInputs(clone(retained?.instance.inputs ?? {}));
      setVariant(retained?.instance.variant ?? '');
      setMode(retained?.instance.mode ?? '');
      setModeChanged(false);
      setVariantChanged(false);
      clear();
      setChanged([]);
      setInitialSlots({});
      setDataTarget({});
    },
    changeVariant(value: string) {
      setVariant(value);
      setVariantChanged(true);
    },
    changeMode(value: string) {
      setMode(value);
      setModeChanged(true);
    },
    changeInput(definition: ComponentDefinition, key: string, value: InputValue) {
      const field = definition.payload.contract.properties.find((p) => p.id === key);
      setInputs((old) => ({
        ...old,
        [key]: field?.type === 'asset' && value === '' ? null : value,
      }));
      setChanged((old) => [...new Set([...old, key])]);
    },
  };
}
