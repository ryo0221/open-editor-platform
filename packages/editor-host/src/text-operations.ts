import type { OperationDeclaration, OperationsAdapter } from '@editor-platform/extension-contract';
import type { EditorHostAdapter } from './index';
import {
  prepareHostTextReplacement,
  readHostElementText,
  type HostTextReplacement,
} from './native-access';

/** Domain packages expose this declaration through the existing operations add-on. */
export const HOST_TEXT_REPLACEMENT: OperationDeclaration = {
  id: 'text.replace',
  version: '1.0.0',
  title: 'Replace plain text',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['selector', 'before', 'after'],
    properties: {
      selector: { type: 'string', maxLength: 1024 },
      before: { type: 'string', maxLength: 20000 },
      after: { type: 'string', maxLength: 20000 },
    },
  },
};

/** No registry, session or execution runtime. Domain knowledge stays in the supplied EP adapter. */
export function hostTextOperations<T>(adapter: EditorHostAdapter<T>): OperationsAdapter<T> {
  const checked = (operation: string, input: unknown, content: T): HostTextReplacement => {
    if (operation !== HOST_TEXT_REPLACEMENT.id) throw Error('Unsupported text operation');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Error('Invalid text input');
    const c = input as Record<string, unknown>;
    if (
      Object.keys(c).some((k) => !['selector', 'before', 'after'].includes(k)) ||
      typeof c.selector !== 'string' ||
      typeof c.before !== 'string' ||
      typeof c.after !== 'string'
    )
      throw Error('Invalid text input');
    if (!adapter.capabilities.proposals || !adapter.native?.text)
      throw Error('Text proposals unsupported');
    if (readHostElementText(adapter, content, c.selector) !== c.before)
      throw Error('The target text changed');
    return { selector: c.selector, before: c.before, after: c.after };
  };
  return Object.freeze({
    checkInput(operation: string, input: unknown, content: T) {
      try {
        checked(operation, input, content);
        return [];
      } catch (e) {
        return [e instanceof Error ? e.message : 'Invalid text operation'];
      }
    },
    command(operation: string, input: unknown, content: T) {
      return prepareHostTextReplacement(adapter, content, checked(operation, input, content));
    },
  });
}
