/** Host-owned Timeline buffers. One owner batch is one native transaction, never a history. */
import {
  transaction,
  type EditorCommand,
  type EditorInputBoundary,
} from '@editor-platform/editor-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
type Command = EditorCommand<StructuredData>;
export interface TimelineForm {
  dirty(): boolean;
  composing?(): boolean;
  prepare(): Command;
  consume(): void;
  finalize(): void;
  focus(): void;
}
export class TimelineForms {
  private forms = new Set<TimelineForm>();
  private committing = false;
  constructor(
    private read: () => StructuredData,
    private writable: () => boolean,
    private execute: (command: Command) => void,
    private changed: () => void,
    private validate: (candidate: StructuredData, command: Command) => void = () => {},
  ) {}
  register(form: TimelineForm) {
    this.forms.add(form);
    this.changed();
    return () => {
      this.forms.delete(form);
      this.changed();
    };
  }
  readonly boundary: EditorInputBoundary = {
    label: '未確定の入力',
    read: () => ({
      dirty: [...this.forms].some((f) => f.dirty()),
      composing: [...this.forms].some((f) => f.composing?.()),
    }),
    prepare: () => this.prepare(),
    focus: () => [...this.forms].find((f) => f.dirty())?.focus(),
  };
  prepare(only?: TimelineForm): () => void {
    if (this.committing) throw Error('入力の確定が進行中です。');
    if ([...this.forms].some((f) => f.composing?.()))
      throw Error('入力変換を確定してから操作してください。');
    const forms = only ? [only] : [...this.forms].filter((f) => f.dirty());
    if (!forms.length) return () => {};
    if (!this.writable()) throw Error('この資料は編集できません。');
    const cmd = transaction(
      '入力をまとめて確定',
      forms.map((f) => f.prepare()),
    );
    // Native commands are pure. Exercise the entire candidate before any owner commits.
    this.validate(cmd.apply(this.read()), cmd);
    let consumed = false;
    return () => {
      if (consumed) return;
      if (this.committing) throw Error('入力の確定が進行中です。');
      this.committing = true;
      try {
        this.execute(cmd);
        consumed = true;
        // Native notify is inside execute; committing blocks reentry until all buffers are consumed.
        // Consume all before form finalization callbacks.
        for (const f of forms) f.consume();
        for (const f of forms) {
          try {
            f.finalize();
          } catch {
            /* Native success remains consumed. */
          }
        }
        this.changed();
      } finally {
        this.committing = false;
      }
    };
  }
}
