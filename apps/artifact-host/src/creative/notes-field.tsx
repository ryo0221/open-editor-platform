import { useState } from 'react';
import { CommitInput } from '@editor-platform/editor-ui';
import type { CreativeProject } from './project';
import type { CreativeSourceCard } from './types';

/** Only the edit's observed field value; source content and history stay native. */
export class NotesFieldDraft {
  constructor(private base: string) {}

  begin(incoming: string, displayed: string) {
    // A retained draft after rejection must not silently adopt the newer source value.
    if (displayed === incoming) this.base = incoming;
  }

  commit<T>(
    project: CreativeProject<T>,
    identity: Pick<CreativeSourceCard, 'id' | 'elementId'>,
    fieldId: string,
    value: string,
  ) {
    const fresh = project.cards.find(
      (card) => card.id === identity.id && card.elementId === identity.elementId,
    );
    const field = fresh?.fields.find((candidate) => candidate.id === fieldId);
    if (!fresh || !field) throw Error('正本の項目が見つかりません。');
    if (field.value !== this.base)
      throw Error(
        '入力中に正本の同じ項目が変更されました。入力は保持しています。確認してから再入力してください。',
      );
    project.source.execute(project.mode.edit(project.source.content, fresh, fieldId, value));
    // Native commands may normalize the submitted text (e.g. a LO heading trims its name).
    // Subsequent commits compare against the value actually stored by the source.
    this.base =
      project.cards
        .find((card) => card.id === identity.id && card.elementId === identity.elementId)
        ?.fields.find((candidate) => candidate.id === fieldId)?.value ?? value;
    return this.base;
  }
}

export function CreativeNotesField<T>({
  project,
  card,
  field,
  activateSource,
  changed,
  onError,
}: {
  project: CreativeProject<T>;
  card: CreativeSourceCard;
  field: CreativeSourceCard['fields'][number];
  activateSource(): void;
  changed(): void;
  onError(error: unknown): void;
}) {
  const [draft] = useState(() => new NotesFieldDraft(field.value));
  return (
    <div
      onFocusCapture={(event) => {
        activateSource();
        if (event.target instanceof HTMLInputElement) {
          const fresh = project.cards
            .find((candidate) => candidate.id === card.id && candidate.elementId === card.elementId)
            ?.fields.find((candidate) => candidate.id === field.id);
          if (fresh) draft.begin(fresh.value, event.target.value);
        }
      }}
    >
      <CommitInput
        value={field.value}
        label={field.label}
        onCommit={(value) => {
          try {
            activateSource();
            const stored = draft.commit(project, card, field.id, value);
            changed();
            return stored;
          } catch (error) {
            onError(error);
            return false;
          }
        }}
      />
    </div>
  );
}
