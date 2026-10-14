import { beforeAll, expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { reactUiContractFixture } from '../../../tests/fixtures/react-ui/contracts';
import {
  ReactUiError,
  validateReactPreviewEndpoint,
  validateReactPreviewResponse,
  type ReactPreviewMessageContext,
  type ReactUiDocument,
  type ReactRuntimeResolution,
} from './index';

let document: ReactUiDocument, resolution: ReactRuntimeResolution;
beforeAll(async () => {
  ({ document, resolution } = await reactUiContractFixture());
});
const source = {},
  origin = 'https://preview.example.test';
const context = (mode: 'edit' | 'interact' = 'edit'): ReactPreviewMessageContext => ({
  source,
  origin,
  sessionId: 'preview-session',
  requestId: 'render-1',
  revision: 7,
  mode,
  document,
});
const message = (extra: Record<string, unknown> = {}) => ({
  protocol: 1,
  sessionId: 'preview-session',
  requestId: 'render-1',
  revision: 7,
  type: 'ready',
  resolution,
  ...extra,
});
const event = (data: unknown) => ({ source, origin, data });

it('accepts a pinned Host preview at a different HTTPS origin', () => {
  const endpoint = validateReactPreviewEndpoint(
    'https://editor.example.test',
    { url: `${origin}/preview`, environment: document.environment.ref },
    document.environment.ref,
  );
  expect(endpoint.origin).toBe(origin);
  expect(Object.isFrozen(endpoint.environment)).toBe(true);
});
it('permits different loopback ports for the independent development Host', () => {
  expect(
    validateReactPreviewEndpoint(
      'http://127.0.0.1:5173',
      { url: 'http://127.0.0.1:5181/preview', environment: document.environment.ref },
      document.environment.ref,
    ).origin,
  ).toBe('http://127.0.0.1:5181');
});
it.each([
  'https://editor.example.test/preview',
  'http://preview.example.test/',
  'javascript:alert(1)',
  'data:text/html,preview',
  'https://user:password@preview.example.test',
  `${origin}/preview#execute`,
])('rejects an unsafe/same-origin endpoint %s', (url) => {
  expect(() =>
    validateReactPreviewEndpoint(
      'https://editor.example.test',
      { url, environment: document.environment.ref },
      document.environment.ref,
    ),
  ).toThrow(ReactUiError);
});
it('rejects an endpoint from a different pinned build', () => {
  const environment = { ...document.environment.ref, hash: 'f'.repeat(64) };
  expect(() =>
    validateReactPreviewEndpoint(
      'https://editor.example.test',
      { url: `${origin}/preview`, environment },
      document.environment.ref,
    ),
  ).toThrow(ReactUiError);
});
it('checks source, exact origin, protocol, session, request and revision before accepting ready', () => {
  expect(validateReactPreviewResponse(event(message()), context()).type).toBe('ready');
  for (const envelope of [
    { ...event(message()), source: {} },
    { ...event(message()), source: null },
    { ...event(message()), origin: 'https://wrong.example.test' },
    event(message({ protocol: 2 })),
    event(message({ sessionId: 'foreign' })),
    event(message({ requestId: 'old-request' })),
    event(message({ revision: 6 })),
  ])
    expect(() => validateReactPreviewResponse(envelope, context())).toThrow(ReactUiError);
});
it('rejects readiness with missing Provider/CSS or a different implementation', () => {
  const incomplete = clone(resolution);
  incomplete.dependencies = [];
  expect(() =>
    validateReactPreviewResponse(event(message({ resolution: incomplete })), context()),
  ).toThrow(ReactUiError);
  const mismatch = clone(resolution);
  mismatch.components[0].implementationHash = 'f'.repeat(64);
  expect(() =>
    validateReactPreviewResponse(event(message({ resolution: mismatch })), context()),
  ).toThrow(ReactUiError);
});
it('selects stable component nodes only in edit mode', () => {
  const { resolution: _resolution, ...selection } = message({ type: 'selection', nodeId: 'card' });
  expect(validateReactPreviewResponse(event(selection), context()).type).toBe('selection');
});
it('rejects unknown component selection and selection in interaction mode', () => {
  const { resolution: _resolution, ...selection } = message({
    type: 'selection',
    nodeId: 'missing',
  });
  expect(() => validateReactPreviewResponse(event(selection), context())).toThrow(ReactUiError);
  expect(() =>
    validateReactPreviewResponse(event({ ...selection, nodeId: 'card' }), context('interact')),
  ).toThrow(ReactUiError);
});
it('validates normalized event payloads and leaves persistent composition untouched', () => {
  const original = JSON.stringify(document);
  const { resolution: _resolution, ...callback } = message({
    type: 'callback',
    nodeId: 'input',
    event: 'onChange',
    arguments: ['日本語'],
  });
  expect(validateReactPreviewResponse(event(callback), context('interact')).type).toBe('callback');
  expect(() => validateReactPreviewResponse(event(callback), context('edit'))).toThrow(
    ReactUiError,
  );
  expect(() =>
    validateReactPreviewResponse(event({ ...callback, arguments: [12] }), context('interact')),
  ).toThrow(ReactUiError);
  expect(() =>
    validateReactPreviewResponse(event({ ...callback, nodeId: 'missing' }), context('interact')),
  ).toThrow(ReactUiError);
  expect(JSON.stringify(document)).toBe(original);
});
it('validates addressed runtime exceptions without evaluating code-like messages', () => {
  const { resolution: _resolution, ...response } = message({
    type: 'error',
    diagnostics: [
      {
        code: 'component-exception',
        severity: 'error',
        path: '$.nodes.card',
        message: '</script><script>bad()</script>',
        recovery: 'Restart preview',
      },
    ],
  });
  expect(validateReactPreviewResponse(event(response), context()).type).toBe('error');
  expect(() =>
    validateReactPreviewResponse(
      event({ ...response, diagnostics: [{ code: 'oops' }] }),
      context(),
    ),
  ).toThrow(ReactUiError);
});
