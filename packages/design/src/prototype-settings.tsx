import { useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { Section, CommitInput } from '@editor-platform/editor-ui';
import type { EditorCommand } from '@editor-platform/editor-core';
import type {
  DesignContent,
  DesignElement,
  DesignInteraction,
  DesignPrototypeAction,
} from './model';
import { diagnoseDesignPrototype, setDesignInteractions, setDesignPrototype } from './prototype';

export function DesignInteractionSettings({
  content,
  value,
  inherited,
  label,
  onChange,
  onInherit,
}: {
  content: DesignContent;
  value?: DesignInteraction[];
  inherited?: DesignInteraction[];
  label: string;
  onChange: (v: DesignInteraction[]) => void;
  onInherit?: () => void;
}) {
  const frames = content.elements.filter((e) => e.type === 'frame');
  const effective = value ?? inherited ?? [];
  const actions: DesignPrototypeAction['type'][] = [
    'navigate',
    'switch',
    'back',
    'open-overlay',
    'close-overlay',
  ];
  return (
    <div aria-label={label} style={{ paddingBlock: 6 }}>
      <strong>{label}</strong>
      {onInherit && (
        <button onClick={onInherit} disabled={value === undefined}>
          Use inherited interaction
        </button>
      )}
      {onInherit && <p>{value === undefined ? 'Inherited from component' : 'Instance override'}</p>}
      {(['click', 'tap'] as const).map((trigger) => {
        const interaction = effective.find((i) => i.trigger === trigger);
        const update = (action?: DesignPrototypeAction) =>
          onChange([
            ...effective.filter((i) => i.trigger !== trigger),
            ...(action ? [{ trigger, action }] : []),
          ]);
        return (
          <div key={trigger}>
            <label>
              {trigger} action{' '}
              <select
                aria-label={`${label} ${trigger} action`}
                value={interaction?.action.type ?? ''}
                onChange={(e) => {
                  const type = e.target.value as DesignPrototypeAction['type'] | '';
                  if (!type) update();
                  else if (type === 'back' || type === 'close-overlay') update({ type });
                  else if (frames[0])
                    update({
                      type,
                      frameId:
                        interaction && 'frameId' in interaction.action
                          ? interaction.action.frameId
                          : frames[0].id,
                    });
                }}
              >
                <option value="">No action</option>
                {actions.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </select>
            </label>
            {interaction && 'frameId' in interaction.action && (
              <label>
                Target frame{' '}
                <select
                  aria-label={`${label} ${trigger} target frame`}
                  value={interaction.action.frameId}
                  onChange={(e) =>
                    update({
                      type: interaction.action.type as 'navigate' | 'switch' | 'open-overlay',
                      frameId: e.target.value,
                    })
                  }
                >
                  {!frames.some(
                    (f) =>
                      f.id === ('frameId' in interaction.action ? interaction.action.frameId : ''),
                  ) && (
                    <option value={interaction.action.frameId}>
                      Missing: {interaction.action.frameId}
                    </option>
                  )}
                  {frames.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
export function DesignPrototypeSettings({
  content,
  element,
  apply,
}: {
  content: DesignContent;
  element?: DesignElement;
  apply: (c: EditorCommand<DesignContent>) => void;
}) {
  const [flowId, setFlowId] = useState('');
  const frames = content.elements.filter((e) => e.type === 'frame');
  const prototype = content.prototyping ?? { schemaVersion: 1 as const, flows: [] };
  const flow = prototype.flows.find((f) => f.id === flowId) ?? prototype.flows[0];
  const diagnostics = diagnoseDesignPrototype(content);
  return (
    <Section title="Prototype settings">
      {element && (
        <DesignInteractionSettings
          content={content}
          label="Element interaction"
          value={element.interactions}
          onChange={(value) => apply(setDesignInteractions(element.id, value))}
        />
      )}
      <label>
        Saved start frame{' '}
        <select
          aria-label="Saved prototype start frame"
          value={prototype.startFrameId ?? ''}
          onChange={(e) =>
            apply(setDesignPrototype({ ...prototype, startFrameId: e.target.value || undefined }))
          }
        >
          <option value="">First visible frame</option>
          {prototype.startFrameId && !frames.some((f) => f.id === prototype.startFrameId) && (
            <option value={prototype.startFrameId}>Missing: {prototype.startFrameId}</option>
          )}
          {frames.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Flow definition{' '}
        <select
          aria-label="Flow definition"
          value={flow?.id ?? ''}
          onChange={(e) => setFlowId(e.target.value)}
        >
          <option value="">Choose flow</option>
          {prototype.flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!frames.length || prototype.flows.length >= 100}
        onClick={() => {
          const id = newId('flow');
          apply(
            setDesignPrototype({
              ...prototype,
              flows: [
                ...prototype.flows,
                {
                  id,
                  name: `Flow ${prototype.flows.length + 1}`,
                  frameIds: [prototype.startFrameId ?? frames[0].id],
                },
              ],
            }),
          );
          setFlowId(id);
        }}
      >
        Add prototype flow
      </button>
      {flow && (
        <>
          <CommitInput
            label="Flow name"
            value={flow.name}
            onCommit={(name) =>
              apply(
                setDesignPrototype({
                  ...prototype,
                  flows: prototype.flows.map((f) => (f.id === flow.id ? { ...f, name } : f)),
                }),
              )
            }
          />
          {flow.frameIds.map((id, index) => (
            <div key={index}>
              <label>
                Step {index + 1}{' '}
                <select
                  aria-label={`Flow step ${index + 1}`}
                  value={id}
                  onChange={(e) =>
                    apply(
                      setDesignPrototype({
                        ...prototype,
                        flows: prototype.flows.map((f) =>
                          f.id === flow.id
                            ? {
                                ...f,
                                frameIds: f.frameIds.map((v, i) =>
                                  i === index ? e.target.value : v,
                                ),
                              }
                            : f,
                        ),
                      }),
                    )
                  }
                >
                  {!frames.some((f) => f.id === id) && <option value={id}>Missing: {id}</option>}
                  {frames.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                aria-label={`Remove flow step ${index + 1}`}
                disabled={flow.frameIds.length === 1}
                onClick={() =>
                  apply(
                    setDesignPrototype({
                      ...prototype,
                      flows: prototype.flows.map((f) =>
                        f.id === flow.id
                          ? { ...f, frameIds: f.frameIds.filter((_, i) => i !== index) }
                          : f,
                      ),
                    }),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            disabled={!frames.length || flow.frameIds.length >= 256}
            onClick={() =>
              apply(
                setDesignPrototype({
                  ...prototype,
                  flows: prototype.flows.map((f) =>
                    f.id === flow.id ? { ...f, frameIds: [...f.frameIds, frames[0].id] } : f,
                  ),
                }),
              )
            }
          >
            Add flow step
          </button>
          <button
            onClick={() =>
              apply(
                setDesignPrototype({
                  ...prototype,
                  flows: prototype.flows.filter((f) => f.id !== flow.id),
                }),
              )
            }
          >
            Delete prototype flow
          </button>
        </>
      )}
      {diagnostics.length > 0 && (
        <ul aria-label="Prototype diagnostics">
          {diagnostics.map((d, i) => (
            <li key={i}>
              {d.code}: {d.message}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
