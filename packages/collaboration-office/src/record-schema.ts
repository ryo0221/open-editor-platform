import type { DomainCodec } from '@editor-platform/collaboration-core';

// Temporary accessors into each existing schema. This is never a stored content model.
export type RecordValue = Record<string, unknown> & { id: string };
export type Root = Record<string, unknown>;
export interface Collection {
  key: string;
  fields: readonly string[];
  items: RecordValue[];
  set(items: RecordValue[]): void;
  nested?: string;
  present: boolean;
  clear(): void;
}
export interface Schema<T> {
  base: DomainCodec<T>;
  root: readonly string[];
  validRecordId?(value: unknown): boolean;
  slideReferences?: true;
  manga?: true;
  recordRoots?: readonly string[];
  /** Native discriminators that may be supplied when inserting a record, including Undo. */
  taggedCollections?: readonly string[];
  optionalCollections?: readonly string[];
  /** Dependencies shared by separate fields that jointly describe one native model. */
  atomicRoots?: readonly string[];
  validateTransition?(before: T, after: T): void;
  collections(content: T): Collection[];
}

export function collection(
  owner: object,
  field: string,
  fields: readonly string[],
  key = field,
  nested?: string,
): Collection {
  const root = owner as Root;
  return {
    key,
    fields,
    get items() {
      return (root[field] ?? []) as RecordValue[];
    },
    nested,
    get present() {
      return root[field] !== undefined;
    },
    clear: () => {
      delete root[field];
    },
    set: (items) => {
      root[field] = items;
    },
  };
}
