/**
 * MR2 forms (docs/cad/mecha-design.md, MR2（形態）): the assembly's named sets of joint values.
 * Save the current values as a form, recall one (one edit, one Undo), overwrite, rename and
 * delete it. Which form the current values match is shown, never stored; a form that no longer
 * fits the joints is shown stale and cannot be recalled until it is overwritten.
 */
import { useState } from 'react';
import {
  cadConfigurationLimits,
  configurationStale,
  matchingConfigurations,
  configurationsApply,
  type CadConfiguration,
} from '@editor-platform/cad-core';
import { useEditorInput } from '@editor-platform/editor-ui';
import type { CadAssembly } from './assembly';
import { describeCode, type CadSnapshot } from './controller';

/**
 * A form name typed and not applied is a pending input: save, export and switching are refused
 * until it is applied or cancelled, so it is never lost unseen.
 */
function useNameGuard(label: string, dirty: boolean, focus: string) {
  useEditorInput({
    label,
    read: () => ({ dirty }),
    prepare: () => {
      if (dirty)
        throw new Error(
          `${label}が適用されていません。適用するか取り消してから、もう一度操作してください。`,
        );
      return () => {};
    },
    focus: () => document.querySelector<HTMLElement>(`form[aria-label="${focus}"] input`)?.focus(),
  });
}

function FormRow({
  assembly,
  form,
  current,
  stale,
  disabled,
}: {
  assembly: CadAssembly;
  form: CadConfiguration;
  current: boolean;
  stale: boolean;
  disabled: boolean;
}) {
  const [renaming, setRenaming] = useState<string>();
  useNameGuard(
    `形態「${form.name}」の新しい名前`,
    renaming !== undefined && renaming.trim() !== form.name,
    `Rename form ${form.name}`,
  );
  return (
    <li className="cad-form" data-testid="cad-form" data-form={form.id}>
      <div className="cad-row">
        <strong>{form.name}</strong>
        {current && (
          <small className="cad-part-state" data-state="current">
            現在の形態
          </small>
        )}
        {stale && (
          <small
            className="cad-part-state"
            data-state="stale"
            title={describeCode('configuration-stale')}
          >
            古い形態
          </small>
        )}
      </div>
      {renaming === undefined ? (
        <div className="cad-row" role="group" aria-label={`Form ${form.name}`}>
          <button
            type="button"
            disabled={disabled || stale || current}
            title={stale ? describeCode('configuration-stale') : undefined}
            onClick={() => void assembly.recallForm(form.id)}
          >
            Recall
          </button>
          <button
            type="button"
            disabled={disabled || current}
            onClick={() => void assembly.overwriteForm(form.id)}
          >
            Overwrite
          </button>
          <button type="button" disabled={disabled} onClick={() => setRenaming(form.name)}>
            Rename
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void assembly.removeForm(form.id)}
          >
            Delete
          </button>
        </div>
      ) : (
        <form
          className="cad-row"
          aria-label={`Rename form ${form.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            // Only its own applied rename closes the field; a refused one keeps what was typed.
            if (renaming.trim())
              void assembly.renameForm(form.id, renaming.trim()).then((ok) => {
                if (ok) setRenaming(undefined);
              });
          }}
        >
          <input
            aria-label="New name"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
          />
          <button type="submit" disabled={disabled || !renaming.trim()}>
            Apply name
          </button>
          <button type="button" onClick={() => setRenaming(undefined)}>
            Cancel
          </button>
        </form>
      )}
    </li>
  );
}

export function FormsSection({
  assembly,
  snapshot,
  paused = false,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
  /** A joint is being made: its previewed poses are not content, so no form edit runs. */
  paused?: boolean;
}) {
  const doc = snapshot.content;
  const forms = doc.configurations ?? [];
  const [name, setName] = useState('');
  useNameGuard('形態の名前', name.trim() !== '', 'Save form');
  if (!configurationsApply(doc) && !forms.length) return null;
  const matching = new Set(matchingConfigurations(doc));
  const disabled = snapshot.readOnly || snapshot.busy || paused;
  const full = forms.length >= cadConfigurationLimits.configurations;
  return (
    <div className="cad-forms" data-testid="cad-forms">
      <h3>Forms ({forms.length})</h3>
      <p className="cad-muted" data-testid="cad-form-current">
        {matching.size
          ? `今の値：${forms
              .filter((f) => matching.has(f.id))
              .map((f) => f.name)
              .join('・')}`
          : '今の値はどの形態とも一致しません'}
      </p>
      {forms.length > 0 && (
        <ul aria-label="Forms">
          {forms.map((f) => (
            <FormRow
              key={f.id}
              assembly={assembly}
              form={f}
              current={matching.has(f.id)}
              stale={configurationStale(doc, f)}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
      {!snapshot.readOnly && (
        <form
          className="cad-row"
          aria-label="Save form"
          onSubmit={(e) => {
            e.preventDefault();
            // Only its own saved form clears the name; a refused save, or another form added or
            // removed (an Undo too), keeps what was typed.
            const typed = name.trim();
            if (typed)
              void assembly.saveForm(typed).then((ok) => {
                if (ok) setName((now) => (now.trim() === typed ? '' : now));
              });
          }}
        >
          <input
            aria-label="Form name"
            placeholder="形態の名前"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="submit"
            disabled={disabled || !name.trim() || full}
            title={full ? describeCode('limit-configurations') : undefined}
          >
            Save current as form
          </button>
          {name && (
            <button type="button" onClick={() => setName('')}>
              Clear name
            </button>
          )}
        </form>
      )}
    </div>
  );
}
