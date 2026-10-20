import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import {
  inspectReactUiDocument,
  loadReactUiDocument,
  reactComponentKey,
  validateReactPreviewEndpoint,
  validateReactPreviewBootstrap,
  type ReactPreviewRequest,
  type ReactPreviewResponse,
  type JsonValue,
} from '@editor-platform/react-ui-core';
import {
  ReactComposition,
  ReactPreviewBoundary,
  type ReactPreviewRuntime,
} from '@editor-platform/react-ui-preview';
import * as components from './components';
import { scaleComponents, scaleResolution, scaleSource } from './catalog';
import './styles.css';

const parentOrigin = new URL(location.href).searchParams.get('parentOrigin');
if (!parentOrigin) throw Error('Explicit parent origin required');
validateReactPreviewEndpoint(
  parentOrigin,
  { url: location.href, environment: scaleResolution.environment },
  scaleResolution.environment,
);
const trustedOrigin = new URL(parentOrigin).origin;
const runtime: ReactPreviewRuntime = {
  resolution: scaleResolution,
  components: Object.fromEntries(
    scaleComponents.map((c) => [
      reactComponentKey(c.ref),
      components[c.name as keyof typeof components] as unknown as ComponentType<
        Record<string, unknown>
      >,
    ]),
  ),
  providers: {
    'scale-provider': components.ThemeProvider as ReactPreviewRuntime['providers'][string],
  },
  assets: { 'scale-image': scaleSource.image },
};
type Payload<T = ReactPreviewResponse> = T extends unknown
  ? Omit<T, 'protocol' | 'sessionId' | 'requestId' | 'revision'>
  : never;
type RenderRequest = Extract<ReactPreviewRequest, { type: 'render' }>;
let receive: ((request: RenderRequest) => void) | undefined;
let hostReady = false;
const announce = () => parent.postMessage({ protocol: 1, type: 'host-ready' }, trustedOrigin);
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== trustedOrigin) return;
  if (event.data?.type === 'host-ready-request') {
    validateReactPreviewBootstrap(
      event,
      { source: parent, origin: trustedOrigin },
      'host-ready-request',
    );
    if (hostReady) announce();
    return;
  }
  const raw = event.data as Partial<ReactPreviewRequest>;
  if (
    !raw ||
    raw.protocol !== 1 ||
    raw.type !== 'render' ||
    typeof raw.sessionId !== 'string' ||
    raw.sessionId.length > 128 ||
    typeof raw.requestId !== 'string' ||
    raw.requestId.length > 128 ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision! < 0 ||
    !['edit', 'interact'].includes(raw.mode!) ||
    !raw.viewport ||
    !Number.isSafeInteger(raw.viewport.width) ||
    raw.viewport.width < 240 ||
    raw.viewport.width > 7680 ||
    !Number.isSafeInteger(raw.viewport.height) ||
    raw.viewport.height < 240 ||
    raw.viewport.height > 7680
  )
    return;
  receive?.(raw as RenderRequest);
});
function Preview() {
  const [request, setRequest] = useState<RenderRequest>();
  const [inputs, setInputs] = useState<Record<string, JsonValue>>({});
  const [status, setStatus] = useState('');
  const accepted = useRef<{ session: string; revision: number } | undefined>(undefined);
  const failed = useRef('');
  function send(payload: Payload) {
    if (request)
      parent.postMessage(
        {
          protocol: 1,
          sessionId: request.sessionId,
          requestId: request.requestId,
          revision: request.revision,
          ...payload,
        },
        trustedOrigin,
      );
  }
  useEffect(() => {
    hostReady = true;
    announce();
  }, []);
  receive = (raw) => {
    if (accepted.current?.session === raw.sessionId && raw.revision <= accepted.current.revision)
      return;
    try {
      const inspection = inspectReactUiDocument(raw.document);
      if (!inspection.document || inspection.diagnostics.length)
        throw Error('Invalid scale composition');
      const document = loadReactUiDocument(inspection.document);
      accepted.current = { session: raw.sessionId, revision: raw.revision };
      setRequest({ ...raw, document });
      setInputs(document.fixture);
      setStatus('');
    } catch (error) {
      parent.postMessage(
        {
          protocol: 1,
          sessionId: raw.sessionId,
          requestId: raw.requestId,
          revision: raw.revision,
          type: 'error',
          diagnostics: [
            {
              code: 'preview-invalid',
              severity: 'error',
              path: '$.document',
              message: String(error),
              recovery: 'Keep the draft and correct the composition.',
            },
          ],
        },
        trustedOrigin,
      );
    }
  };
  useEffect(() => {
    if (request && failed.current !== request.requestId)
      send({ type: 'ready', resolution: scaleResolution });
  }, [request]);
  if (!request) return <p>Waiting for composition</p>;
  return (
    <ReactPreviewBoundary
      resetKey={request.requestId}
      onError={(diagnostics) => {
        failed.current = request.requestId;
        send({ type: 'error', diagnostics });
      }}
    >
      <ReactComposition
        document={request.document}
        runtime={runtime}
        width={request.viewport.width}
        inputs={inputs}
        mode={request.mode}
        select={(nodeId) => send({ type: 'selection', nodeId })}
        callback={(nodeId, event, args) => {
          if (event === 'onChange') setInputs((current) => ({ ...current, name: args[0] }));
          setStatus(`${event}: ${args.join(',') || 'called'}`);
          send({ type: 'callback', nodeId, event, arguments: args });
        }}
      />
      <output aria-label="Scale callback">{status}</output>
    </ReactPreviewBoundary>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
