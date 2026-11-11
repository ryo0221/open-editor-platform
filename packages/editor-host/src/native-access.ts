import { clone } from '@editor-platform/artifact-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { EditorHostAdapter } from './index';

/** Machine-readable domain lookup failure; Hosts need no model-specific parsing. */
export class NativeTargetError extends Error {
  constructor(
    public readonly code: 'missing' | 'ambiguous' | 'unsupported',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'NativeTargetError';
  }
}
/** Whole content has a separate entry point; every element selector remains literal. */
export function readHostContent<T>(adapter: EditorHostAdapter<T>, content: T): T {
  if (!adapter.validate(content)) throw new Error('Invalid native content');
  return clone(content);
}

/** A domain selector is opaque to a consuming Host, never an executable path. */
export interface HostTextReplacement {
  selector: string;
  before: string;
  after: string;
}
/** Domain-owned projections and optional proposal preparation. No AI or workflow policy. */
export interface HostNativeAccess<T> {
  /** null: no exact element. Unsupported selectors must not fall back to the whole content. */
  read(content: T, selector: string): unknown | null;
  text?: {
    read(content: T, selector: string): string;
    replace(content: T, change: HostTextReplacement): EditorCommand<T>;
  };
}

export function readHostElement<T>(
  adapter: EditorHostAdapter<T>,
  content: T,
  selector: string,
): unknown | null {
  if (!adapter.validate(content)) throw new Error('Invalid native content');
  if (!adapter.native) throw new Error('Native element projection is unsupported');
  return clone(adapter.native.read(content, selector));
}

export function readHostElementText<T>(
  adapter: EditorHostAdapter<T>,
  content: T,
  selector: string,
): string {
  if (!adapter.validate(content)) throw new Error('Invalid native content');
  if (!adapter.native?.text) throw new Error('Native text projection is unsupported');
  return adapter.native.text.read(content, selector);
}

/** Data becomes a native command only through the registered domain capability. */
export function prepareHostTextReplacement<T>(
  adapter: EditorHostAdapter<T>,
  content: T,
  change: HostTextReplacement,
): EditorCommand<T> {
  const fixed = clone(change);
  if (!adapter.capabilities.proposals || !adapter.native?.text)
    throw new Error('Native text proposals are unsupported');
  if (
    !fixed ||
    typeof fixed.selector !== 'string' ||
    typeof fixed.before !== 'string' ||
    typeof fixed.after !== 'string'
  )
    throw new Error('Invalid text replacement');
  if (readHostElementText(adapter, content, fixed.selector) !== fixed.before)
    throw new Error('The target text changed');
  const command = adapter.native.text.replace(content, fixed);
  return {
    ...command,
    apply(current: T) {
      if (readHostElementText(adapter, current, fixed.selector) !== fixed.before)
        throw new Error('The target text changed');
      const next = command.apply(current);
      if (!adapter.validate(next)) throw new Error('Invalid replacement result');
      return next;
    },
  };
}
