/** Domain-only Surface: the Host supplies controller/session/authority/persistence. */
import type { DefinitionD2 } from '@editor-platform/extension-contract/draft2';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import { createCounter, isCounter, setCounter, type Counter } from './index';
export { createCounter };
export function controlledCounterDefinition(
  packageHash: string,
  mount: NonNullable<DefinitionD2<Counter, never>['mount']>,
): DefinitionD2<Counter, never> {
  return {
    manifest: {
      id: 'example.controlled-counter',
      version: '0.0.0-experiment.1',
      packageHash,
      contractVersion: '1.0.0-draft.2',
      artifactKind: 'example.counter',
      schemaVersion: 1,
      surface: true,
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
      addons: {
        edit: { version: 'local-edit@0-draft', requirement: 'optional' },
        inputs: { version: 'inputs@0-draft', requirement: 'optional' },
        save: { version: 'local-persistence@0-draft', requirement: 'optional' },
        lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
      },
      licenseNotices: ['Prototype; repository license terms remain unchanged.'],
    },
    validate: isCounter,
    mount,
  };
}
/** The deterministic non-UI entrypoint is also the UI command path. */
export function setControlledCounter(editor: ControlledSurfaceController<Counter>, value: number) {
  const view = editor.getSnapshot();
  if (view.state !== 'open')
    return { state: 'refused' as const, code: 'ScopeRevoked', message: 'ScopeRevoked' };
  return editor.execute({
    baseRevision: view.snapshot.revision,
    command: value === view.snapshot.content.value ? null : setCounter(value),
  });
}
export function mountControlledCounter(
  container: HTMLElement,
  editor: ControlledSurfaceController<Counter>,
): () => void {
  const root = container.ownerDocument.createElement('section');
  root.setAttribute('aria-label', 'Controlled Counter');
  const output = container.ownerDocument.createElement('output');
  output.setAttribute('aria-label', 'Counter value');
  const status = container.ownerDocument.createElement('p');
  status.setAttribute('role', 'status');
  const editButtons: HTMLButtonElement[] = [];
  root.append(output);
  const button = (label: string, action: () => unknown) => {
    const element = container.ownerDocument.createElement('button');
    element.textContent = label;
    element.onclick = () => {
      action();
    };
    root.append(element);
    return element;
  };
  editButtons.push(
    button('Increment', () => {
      const view = editor.getSnapshot();
      if (view.state === 'open') setControlledCounter(editor, view.snapshot.content.value + 1);
    }),
    button('Reset', () => setControlledCounter(editor, 0)),
    button('Undo', () => editor.undo()),
    button('Redo', () => editor.redo()),
  );
  const save = button('Save', () => {
    void editor.save().then((result) => {
      if (!disposed)
        status.textContent = result.state === 'outcome' ? result.outcome.state : result.code;
    });
  });
  root.append(status);
  container.append(root);
  let disposed = false;
  const render = () => {
    const view = editor.getSnapshot();
    if (view.state === 'revoked') {
      root.remove();
      return;
    }
    output.textContent = String(view.snapshot.content.value);
    for (const button of editButtons) button.disabled = !view.canEdit;
    save.disabled = !view.canSave || view.saving;
    if (view.lastOperation?.state === 'refused') status.textContent = view.lastOperation.code;
  };
  const stop = editor.subscribe(render);
  render();
  return () => {
    disposed = true;
    stop();
    for (const button of [...editButtons, save]) button.onclick = null;
    root.remove();
  };
}
