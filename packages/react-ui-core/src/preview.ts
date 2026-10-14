import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { array, checkData, fields, finite, id, identifier, object, reject, same } from './data';
import { loadReactUiDocument } from './document';
import { inspectReactRuntimeResolution } from './preflight';
import { checkEnvironmentRef, reactComponentKey } from './registration';
import { valueMatches } from './schema';
import type { ReactPreviewResponse, ReactPreviewBootstrap } from './adapters';
import type { ReactEnvironmentRef, ReactUiDocument } from './types';

/** Validate Host-provided endpoint metadata; never navigate or fetch from the pure package. */
export function validateReactPreviewEndpoint(
  editorOrigin: string,
  raw: unknown,
  expectedEnvironment: ReactEnvironmentRef,
): { url: string; origin: string; environment: ReactEnvironmentRef } {
  checkData(raw);
  checkData(expectedEnvironment);
  checkEnvironmentRef(expectedEnvironment, '$.preview.environment');
  const endpoint = object(raw, '$.preview');
  fields(endpoint, ['url', 'environment'], [], '$.preview');
  let editor: URL, url: URL;
  try {
    editor = new URL(editorOrigin);
    url = new URL(String(endpoint.url));
  } catch {
    reject('preview-origin', '$.preview.url', 'Expected absolute Editor and preview URLs');
  }
  const supported = (url: URL) =>
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  if (
    typeof endpoint.url !== 'string' ||
    !supported(url) ||
    !supported(editor) ||
    url.username ||
    url.password ||
    editor.origin === url.origin ||
    editor.origin !== editorOrigin ||
    url.hash
  )
    reject(
      'preview-origin',
      '$.preview.url',
      'Preview must use a separate HTTPS origin (loopback HTTP allowed in development)',
    );
  if (!same(endpoint.environment, expectedEnvironment))
    reject(
      'preview-environment',
      '$.preview.environment',
      'Preview build identity differs from the pinned environment',
    );
  return deepFreeze({ url: url.href, origin: url.origin, environment: clone(expectedEnvironment) });
}
export interface ReactPreviewMessageContext {
  /** Actual iframe.contentWindow / MessagePort object; compare event.source by identity. */
  source: object;
  origin: string;
  sessionId: string;
  requestId: string;
  revision: number;
  mode: 'edit' | 'interact';
  document: ReactUiDocument;
}
export function validateReactPreviewBootstrap(
  event: { source: object | null; origin: string; data: unknown },
  context: Pick<ReactPreviewMessageContext, 'source' | 'origin'>,
  type: ReactPreviewBootstrap['type'],
): ReactPreviewBootstrap {
  if (
    !context.source ||
    event.source !== context.source ||
    event.origin !== context.origin ||
    ['*', 'null'].includes(context.origin)
  )
    reject('preview-sender', '$.message', 'Bootstrap source/origin is not the expected frame');
  checkData(event.data);
  const message = object(event.data, '$.message');
  fields(message, ['protocol', 'type'], [], '$.message');
  if (message.protocol !== 1 || message.type !== type)
    reject('preview-protocol', '$.message', 'Unsupported preview bootstrap');
  return { protocol: 1, type };
}
/** Exact render response validation; the Host owns rendering and the Surface owns UI. */
export function validateReactPreviewResponse(
  event: { source: object | null; origin: string; data: unknown },
  context: ReactPreviewMessageContext,
): ReactPreviewResponse {
  if (
    !context.source ||
    event.source !== context.source ||
    event.origin !== context.origin ||
    context.origin === '*' ||
    context.origin === 'null'
  )
    reject(
      'preview-sender',
      '$.message',
      'Message source/origin is not the expected preview frame',
    );
  checkData(event.data);
  const r = object(event.data, '$.message');
  const common = ['protocol', 'sessionId', 'requestId', 'revision', 'type'];
  if (r.protocol !== 1)
    reject('preview-protocol', '$.message.protocol', 'Unsupported preview protocol');
  id(r.sessionId, '$.message.sessionId');
  id(r.requestId, '$.message.requestId');
  finite(r.revision, '$.message.revision', 0, Number.MAX_SAFE_INTEGER, true);
  if (
    r.sessionId !== context.sessionId ||
    r.requestId !== context.requestId ||
    r.revision !== context.revision
  )
    reject('preview-stale', '$.message', 'Message belongs to another session/request/revision');
  const document = loadReactUiDocument(context.document);
  switch (r.type) {
    case 'ready':
      fields(r, [...common, 'resolution'], [], '$.message');
      {
        const problems = inspectReactRuntimeResolution(document, r.resolution);
        if (problems.length)
          reject(
            'preview-resolution',
            '$.message.resolution',
            problems.map((d) => d.message).join('; '),
          );
      }
      break;
    case 'selection':
      fields(r, [...common, 'nodeId'], [], '$.message');
      if (context.mode !== 'edit' || !document.nodes.some((n) => n.id === r.nodeId))
        reject(
          'preview-selection',
          '$.message.nodeId',
          'Selection is not an editable stable component node',
        );
      break;
    case 'callback':
      fields(r, [...common, 'nodeId', 'event', 'arguments'], [], '$.message');
      identifier(r.event, '$.message.event');
      {
        const node = document.nodes.find((n) => n.id === r.nodeId);
        const component =
          node &&
          document.components.find(
            (c) =>
              reactComponentKey(c.ref) === reactComponentKey(node.component) &&
              same(c.ref, node.component),
          );
        const schema = component?.events[r.event];
        const args = array(r.arguments, '$.message.arguments', 8);
        if (
          context.mode !== 'interact' ||
          !schema ||
          schema.parameters.length !== args.length ||
          !schema.parameters.every((s, i) => valueMatches(s, args[i]))
        )
          reject(
            'preview-callback',
            '$.message',
            'Callback arguments do not match the registered event in interaction mode',
          );
      }
      break;
    case 'error':
      fields(r, [...common, 'diagnostics'], [], '$.message');
      array(r.diagnostics, '$.message.diagnostics', 128).forEach((raw, i) => {
        const path = `$.message.diagnostics.${i}`,
          d = object(raw, path);
        fields(d, ['code', 'severity', 'path', 'message', 'recovery'], [], path);
        if (
          !['error', 'warning'].includes(String(d.severity)) ||
          ['code', 'path', 'message', 'recovery'].some(
            (k) => typeof d[k] !== 'string' || String(d[k]).length > 5000,
          )
        )
          reject('preview-diagnostic', path, 'Invalid addressed preview diagnostic');
      });
      break;
    default:
      reject('preview-protocol', '$.message.type', 'Unsupported preview response');
  }
  return deepFreeze(clone(event.data as ReactPreviewResponse));
}
