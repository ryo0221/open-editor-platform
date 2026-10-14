import { useRef, useState } from 'react';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { type EditorCommand } from '@editor-platform/editor-core';
import { Dialog, useEditorInput } from '@editor-platform/editor-ui';
import { publicationParts, publishDesignComponent } from './component-publication';
import { type DesignContent } from './model';
import { designWebTagsFor, type DesignWebComponent, type DesignWebTag } from './web-contract';
export function ComponentPublicationDialog({
  content,
  id,
  readOnly,
  readOnlyReason,
  apply,
  diagnostics,
  onClose,
}: {
  content: DesignContent;
  id: string;
  readOnly: boolean;
  readOnlyReason?: string;
  apply(command: EditorCommand<DesignContent>): boolean;
  diagnostics?: (
    candidate: DesignContent,
    componentId: string,
  ) => { code: string; path: string; message: string }[];
  onClose(): void;
}) {
  const component = content.components.find((component) => component.id === id)!;
  const parts = publicationParts(component);
  const [web, setWeb] = useState<DesignWebComponent>(() =>
    clone(
      component.web ?? {
        symbol: `NativeComponent${content.components.indexOf(component) + 1}`,
        version: '1.0.0',
        props: {},
        variants: {},
        slots: {},
      },
    ),
  );
  const [tags, setTags] = useState<Record<string, DesignWebTag>>(() =>
    Object.fromEntries(
      parts
        .filter((part) => part.type !== 'react' && part.type !== 'instance')
        .map((part) => [
          part.id,
          part.web?.tag ?? (part.type === 'text' ? 'p' : part.type === 'image' ? 'img' : 'div'),
        ]),
    ),
  );
  const [propName, setPropName] = useState('text');
  const [propPart, setPropPart] = useState(parts[0]?.id ?? '');
  const [propField, setPropField] = useState('text');
  const [slotName, setSlotName] = useState('body');
  const slotParts = parts.filter((part) => tags[part.id] && tags[part.id] !== 'img');
  const [slotPart, setSlotPart] = useState(slotParts[0]?.id ?? '');
  const currentSlotPart = slotParts.find((part) => part.id === slotPart) ?? slotParts[0];
  if (slotPart !== (currentSlotPart?.id ?? '')) setSlotPart(currentSlotPart?.id ?? '');
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const initial = useRef(canonicalJson({ web, tags }));
  const composing = useRef(false);
  const [composition, setComposition] = useState(false);
  const committed = useRef(false);
  const base = useRef(canonicalJson(component));
  let edit: EditorCommand<DesignContent> | undefined;
  let problems: { code: string; path: string; message: string }[] = [];
  let invalid = '';
  try {
    edit = publishDesignComponent(content, id, web, tags);
    const candidate = edit.apply(content);
    problems = diagnostics?.(candidate, id) ?? [];
  } catch (error) {
    invalid = String(error instanceof Error ? error.message : error);
  }
  function prepare() {
    if (readOnly || base.current !== canonicalJson(component))
      throw new Error('部品が変更済み、または編集できません。設定を開き直してください。');
    if (invalid || problems.length || !edit)
      throw new Error(invalid || problems[0]?.message || '公開条件を確認してください。');
    const fixed = edit;
    return () => {
      if (!apply(fixed)) return false;
      committed.current = true;
      onClose();
    };
  }
  useEditorInput({
    label: 'React公開設定',
    read: () => ({
      dirty: !committed.current && canonicalJson({ web, tags }) !== initial.current,
      composing: composing.current,
    }),
    prepare,
    focus: () => root.current?.querySelector<HTMLInputElement>('input')?.focus(),
  });
  const available = [
    ...(content.web?.registrations ?? []).map((registration) => ({
      registryId: registration.ref.registryId,
      componentId: registration.ref.componentId,
    })),
    ...content.components
      .filter((component) => component.web && component.id !== id)
      .map((component) => ({ registryId: 'native-design', componentId: component.id })),
  ];
  const choices = [
    ...new Map(available.map((ref) => [`${ref.registryId}/${ref.componentId}`, ref])).entries(),
  ];
  const [allowed, setAllowed] = useState(() => choices.map(([key]) => key));
  const accepts = choices.filter(([key]) => allowed.includes(key)).map(([, ref]) => ref);
  return (
    <Dialog title="React component publication" onClose={onClose}>
      <div
        ref={root}
        onCompositionStart={() => {
          composing.current = true;
          setComposition(true);
        }}
        onCompositionEnd={() => {
          composing.current = false;
          setComposition(false);
        }}
      >
        <h3>{component.name} · native component</h3>
        <p>
          1. HTML意味を確認 → 2. 公開props・slotsを設定 → 3.
          設定を保存してReact出力・アプリ再利用へ進みます。
        </p>
        {readOnlyReason && <p role="status">{readOnlyReason}</p>}
        <fieldset disabled={readOnly}>
          <label>
            React symbol
            <input
              aria-label="Publication symbol"
              value={web.symbol}
              onChange={(event) => setWeb({ ...web, symbol: event.target.value })}
            />
          </label>
          <label>
            公開版
            <input
              aria-label="Publication version"
              value={web.version}
              onChange={(event) => setWeb({ ...web, version: event.target.value })}
            />
          </label>
          <h4>HTML意味</h4>
          {parts
            .filter((part) => part.type !== 'react' && part.type !== 'instance')
            .map((part) => (
              <label key={part.id}>
                {part.name}
                <select
                  aria-label={`HTML meaning ${part.name}`}
                  value={tags[part.id] ?? ''}
                  onChange={(event) =>
                    setTags({ ...tags, [part.id]: event.target.value as DesignWebTag })
                  }
                >
                  <option value="">意味を選択</option>
                  {designWebTagsFor(part.type).map((tag) => (
                    <option key={tag}>{tag}</option>
                  ))}
                </select>
              </label>
            ))}
          <h4>公開props</h4>
          {Object.entries(web.props).map(([key, prop]) => (
            <p key={key}>
              {key} → {parts.find((part) => part.id === prop.target.elementId)?.name} /{' '}
              {prop.target.field}
              <button
                onClick={() => {
                  const props = { ...web.props };
                  delete props[key];
                  setWeb({ ...web, props });
                }}
              >
                Remove prop {key}
              </button>
            </p>
          ))}
          <label>
            prop名
            <input
              aria-label="Public prop name"
              value={propName}
              onChange={(event) => setPropName(event.target.value)}
            />
          </label>
          <label>
            対象部品
            <select
              aria-label="Public prop part"
              value={propPart}
              onChange={(event) => setPropPart(event.target.value)}
            >
              {parts.map((part) => (
                <option key={part.id} value={part.id}>
                  {part.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            値
            <select
              aria-label="Public prop field"
              value={propField}
              onChange={(event) => setPropField(event.target.value)}
            >
              {['text', 'fill', 'src', 'alt'].map((field) => (
                <option key={field}>{field}</option>
              ))}
            </select>
          </label>
          <button
            disabled={!propName.trim() || Object.hasOwn(web.props, propName)}
            onClick={() => {
              const part = parts.find((part) => part.id === propPart)!;
              setWeb({
                ...web,
                props: {
                  ...web.props,
                  [propName]: {
                    schema: { type: 'string' },
                    required: false,
                    default: String(part[propField as 'text'] ?? ''),
                    target: { elementId: propPart, field: propField },
                  },
                },
              });
            }}
          >
            Add public prop
          </button>
          <h4>公開slots</h4>
          <p>既存の本文を残す任意slotです。許可先はこのHostの登録部品です。</p>
          {choices.length === 0 && (
            <p>slotの許可先がありません。Hostへ部品を登録してからslotを追加してください。</p>
          )}
          {choices.map(([key, ref]) => (
            <label key={key}>
              <input
                type="checkbox"
                aria-label={`Allow slot component ${key}`}
                checked={allowed.includes(key)}
                onChange={(event) =>
                  setAllowed(
                    event.target.checked
                      ? [...allowed, key]
                      : allowed.filter((value) => value !== key),
                  )
                }
              />
              {content.web?.registrations.find(
                (registration) =>
                  registration.ref.registryId === ref.registryId &&
                  registration.ref.componentId === ref.componentId,
              )?.name ??
                content.components.find((component) => component.id === ref.componentId)?.name ??
                ref.componentId}
            </label>
          ))}
          {Object.entries(web.slots ?? {}).map(([key, slot]) => (
            <p key={key}>
              {key} → {parts.find((part) => part.id === slot.elementId)?.name}
              <button
                onClick={() => {
                  const slots = { ...web.slots };
                  delete slots[key];
                  setWeb({ ...web, slots });
                }}
              >
                Remove slot {key}
              </button>
            </p>
          ))}
          <label>
            slot名
            <input
              aria-label="Public slot name"
              value={slotName}
              onChange={(event) => setSlotName(event.target.value)}
            />
          </label>
          <label>
            対象部品
            <select
              aria-label="Public slot part"
              value={slotPart}
              onChange={(event) => setSlotPart(event.target.value)}
            >
              {slotParts.map((part) => (
                <option key={part.id} value={part.id}>
                  {part.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={
              !slotName.trim() ||
              accepts.length === 0 ||
              Object.hasOwn(web.slots ?? {}, slotName) ||
              !tags[slotPart] ||
              tags[slotPart] === 'img'
            }
            onClick={() =>
              setWeb({
                ...web,
                slots: {
                  ...web.slots,
                  [slotName]: {
                    elementId: slotPart,
                    prop: slotName === 'body' ? 'children' : slotName,
                    minimum: 0,
                    maximum: 100,
                    accepts,
                  },
                },
              })
            }
          >
            Add public slot
          </button>
        </fieldset>
        <p role="status">
          公開条件:{' '}
          {invalid || problems.length
            ? '設定の修正が必要です'
            : '参照・HTML意味・公開入力を確認しました'}
        </p>
        {invalid && <p role="alert">{invalid}</p>}
        {problems.map((problem, i) => (
          <p role="alert" key={i}>
            {problem.path}: {problem.message}
          </p>
        ))}
        {error && <p role="alert">{error}</p>}
        <button
          disabled={readOnly || composition || !!invalid || !!problems.length}
          onClick={() => {
            try {
              prepare()();
            } catch (error) {
              setError(String(error instanceof Error ? error.message : error));
            }
          }}
        >
          Save React publication settings
        </button>
        <button onClick={onClose}>Cancel publication settings</button>
      </div>
    </Dialog>
  );
}
