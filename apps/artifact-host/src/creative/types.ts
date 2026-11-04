import type { ReactNode } from 'react';
import type { EditorCommand, ElementAddress } from '@editor-platform/editor-core';
import type { EditorHostAdapter } from '@editor-platform/editor-host';
import type { DesignContent } from '@editor-platform/design/model';

/** Read-through projection. Never persisted as another character/location record. */
export interface CreativeSourceCard {
  id: string;
  elementId: string;
  name: string;
  summary: string;
  fields: { id: string; label: string; value: string; editable: boolean }[];
}
/** Host preset only. Groups and parts refer to ordinary component element IDs. */
export interface CreativePartGroup {
  id: string;
  label: string;
  parts: { id: string; label: string }[];
}
export interface CreativeMode<T> {
  id: string;
  title: string;
  itemLabel: string;
  sourceLabel: string;
  adapter: EditorHostAdapter<T>;
  seed(): T;
  cards(content: T): CreativeSourceCard[];
  create(content: T, name: string, summary: string): EditorCommand<T>;
  edit(content: T, card: CreativeSourceCard, fieldId: string, value: string): EditorCommand<T>;
  sourceView(props: {
    content: T;
    execute(command: EditorCommand<T>): boolean;
    readOnly: boolean;
    focus?: ElementAddress;
  }): ReactNode;
  design(name: string): DesignContent;
  componentId: string;
  groups: readonly CreativePartGroup[];
}
