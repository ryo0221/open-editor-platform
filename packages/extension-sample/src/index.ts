import { command } from '@editor-platform/editor-core';
import { CONTRACT_VERSION, type ExtensionDefinition } from '@editor-platform/extension-contract';
export interface Counter {
  id: 'counter';
  value: number;
}
export const createCounter = (): Counter => ({ id: 'counter', value: 0 });
export const setCounter = (value: number) =>
  command<Counter>('counter.set', 'Set counter', (content) => ({ ...content, value }));
export function isCounter(value: unknown): value is Counter {
  if (!value || typeof value !== 'object') return false;
  const c = value as Counter;
  return (
    Object.keys(c).length === 2 &&
    c.id === 'counter' &&
    Number.isSafeInteger(c.value) &&
    c.value >= 0 &&
    c.value <= 1000
  );
}
/** Hash is supplied by the trusted Host build; never treated as self-attested provenance. */
export function counterExtension(packageHash: string): ExtensionDefinition<Counter> {
  return {
    manifest: {
      contractVersion: CONTRACT_VERSION,
      id: 'example.counter',
      version: '0.0.1',
      artifactKind: 'example.counter',
      schemaVersion: 1,
      packageHash,
      capabilities: ['local-edit', 'surface', 'persistence'],
      permissions: ['artifact:read', 'artifact:write'],
      licenseNotices: ['Prototype; repository license terms remain unchanged.'],
    },
    validate: isCounter,
    mount(container, host) {
      const output = document.createElement('output');
      output.setAttribute('aria-label', 'Counter value');
      const error = document.createElement('p');
      error.setAttribute('role', 'status');
      const root = document.createElement('section');
      const render = () => {
        output.textContent = String(host.read().value);
      };
      root.append(output);
      for (const [label, action] of [
        ['Increment', () => host.execute(setCounter(host.read().value + 1))],
        ['Reset', () => host.execute(setCounter(0))],
        ['Undo', () => host.undo()],
        ['Redo', () => host.redo()],
        ['Save', () => host.save()],
      ] as const) {
        const button = document.createElement('button');
        button.textContent = label;
        button.onclick = async () => {
          try {
            await action();
            error.textContent = '';
            render();
          } catch (e) {
            error.textContent = e instanceof Error ? e.message : 'Operation failed';
          }
        };
        root.append(button);
      }
      root.append(error);
      container.append(root);
      render();
      return () => root.remove();
    },
  };
}
