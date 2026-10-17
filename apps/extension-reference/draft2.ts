import { command } from '@editor-platform/editor-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import {
  FakeStorage,
  ManualClock,
  referenceBinding,
  toyDefinition,
} from '@editor-platform/extension-runtime/reference';
import type { Context } from '@editor-platform/extension-contract/draft2';
const style = document.createElement('style');
style.textContent =
  'body{font:16px system-ui;max-width:760px;margin:24px auto;padding:16px;color:#172a3a;background:#f1f5f9}button{padding:12px;margin:5px;border:1px solid #667788;border-radius:6px;background:white}section{padding:16px;margin:16px 0;background:white;border-radius:12px}output{display:block;overflow-wrap:anywhere;margin:8px}';
document.head.append(style);
const heading = document.createElement('h1');
heading.textContent = 'Extension draft.2 — fake async reference';
document.body.append(heading);
const note = document.createElement('p');
note.textContent =
  'Volatile toy storage only. No production Host, durability, domain integration or sandbox claim.';
document.body.append(note);
const surface = document.createElement('section');
surface.setAttribute('aria-label', 'Extension surface');
document.body.append(surface);
function button(container: HTMLElement, label: string, action: () => void) {
  const value = document.createElement('button');
  value.textContent = label;
  value.onclick = action;
  container.append(value);
}
function mount(container: HTMLElement, context: Context<{ value: number }, string>) {
  const value = document.createElement('output');
  value.setAttribute('aria-label', 'Value');
  const status = document.createElement('output');
  status.setAttribute('aria-label', 'Extension save');
  status.textContent = 'Ready';
  container.append(value, status);
  const refresh = () => {
    value.textContent = String(context.basic.read().content.value);
  };
  refresh();
  button(container, 'Increment', () => {
    if (context.addons.edit.state === 'granted') {
      context.addons.edit.api.execute(
        command('increment', 'Increment', (content) => ({ value: content.value + 1 })),
      );
      refresh();
    }
  });
  button(container, 'Save capture', () => {
    if (context.addons.save.state !== 'granted') return;
    status.textContent = 'Pending';
    void context.addons.save.api.save().then(
      (result) => {
        status.textContent = result.state;
      },
      (error) => {
        status.textContent = error instanceof Error ? error.message : String(error);
      },
    );
  });
  if (context.addons.lifecycle.state === 'granted')
    context.addons.lifecycle.api.registerDisposable('surface', () => {
      container.replaceChildren();
      const message = document.createElement('p');
      message.textContent = 'Scope revoked';
      container.append(message);
    });
}
const clock = new ManualClock();
const registry = new ReferenceRegistry(clock);
const binding = referenceBinding({ value: 0 });
const storage = new FakeStorage<{ value: number }>('ui-toy');
binding.storage = storage;
const definition = toyDefinition();
definition.manifest.surface = true;
definition.mount = mount;
const installed = registry.install(definition, {
  trust: 'trusted',
  verifiedPin: definition.manifest,
});
const opened = installed.open(binding);
if (opened.state !== 'opened') throw new Error(opened.code);
const handle = opened.handle;
handle.mount(surface);
const host = document.createElement('section');
host.setAttribute('aria-label', 'Fake Host controls');
const hostTitle = document.createElement('h2');
hostTitle.textContent = 'Fake Host controls';
host.append(hostTitle);
document.body.append(host);
const outcome = document.createElement('output');
outcome.setAttribute('aria-label', 'Host outcome');
outcome.textContent = 'No operation';
host.append(outcome);
const refresh = () => {
  const result = registry.saves.observations().at(-1);
  outcome.textContent = result?.outcome?.state ?? (result ? 'Captured' : 'No operation');
};
button(host, 'Acknowledge commit', () => {
  const request = storage.requests.at(-1);
  if (!request) return;
  storage.commit(request.operationId);
  queueMicrotask(() => queueMicrotask(refresh));
});
button(host, 'Advance settlement deadline', () => {
  clock.advanceTo(clock.now() + 100);
  refresh();
});
button(host, 'Reconcile committed', () => {
  const request = storage.requests.at(-1);
  if (!request) return;
  storage.commit(request.operationId, false);
  registry.saves.reconcile(request.operationId, storage.evidence(request.operationId));
  refresh();
});
button(host, 'Revoke scope', () => {
  handle.revoke('host-close');
  refresh();
});
void registry.saves.nextAdmission().then(() => {
  refresh();
});
