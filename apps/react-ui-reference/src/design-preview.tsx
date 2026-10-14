import {
  referenceDesignOriginalResolution,
  referenceReviewedCardFunctions,
} from './design-catalog';
import { useMemo } from 'react';
import {
  convertDesignToReact,
  designReactResolution,
  type DesignReactConversion,
} from '@editor-platform/design-react-core';
import { nativeDesignRuntime } from '@editor-platform/design-react-preview';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import {
  inspectReactUiDocument,
  loadReactUiDocument,
  reactComponentKey,
  validateReactPreviewEndpoint,
  validateReactPreviewBootstrap,
  type ReactPreviewBootstrap,
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
import * as revisedComponents from './components-v2';
import {
  referenceComponents,
  referenceResolution,
  referenceImage,
  referenceResolutionFor,
  referenceTextRevision,
} from './catalog';
import '../public/styles/tokens.css';
const parentOrigin = new URL(location.href).searchParams.get('parentOrigin');
if (!parentOrigin) throw new Error('Host requires an explicit parent origin');
validateReactPreviewEndpoint(
  parentOrigin,
  { url: location.href, environment: referenceResolution.environment },
  referenceResolution.environment,
);
const trustedOrigin = new URL(parentOrigin).origin;
const runtime: ReactPreviewRuntime = {
  resolution: referenceResolution,
  components: Object.fromEntries(
    [...referenceComponents, referenceTextRevision].map((c) => [
      reactComponentKey(c.ref),
      (c === referenceTextRevision
        ? revisedComponents.Text
        : components[c.name as keyof typeof components]) as unknown as ComponentType<
        Record<string, unknown>
      >,
    ]),
  ),
  providers: {
    'theme-provider':
      components.ThemeProvider as unknown as ReactPreviewRuntime['providers'][string],
  },
  assets: { 'product-image': referenceImage },
};
type DesignRequest = Extract<ReactPreviewRequest, { type: 'render' }> & {
  conversion?: DesignReactConversion;
  conversions: DesignReactConversion[];
};
let receive: (request: DesignRequest) => void;
let hostReady = false;
const announceReady = () =>
  parent.postMessage(
    { protocol: 1, type: 'host-ready' } satisfies ReactPreviewBootstrap,
    trustedOrigin,
  );
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== trustedOrigin) return;
  if (event.data?.type === 'host-ready-request') {
    try {
      validateReactPreviewBootstrap(
        event,
        { source: parent, origin: trustedOrigin },
        'host-ready-request',
      );
      if (hostReady) announceReady();
    } catch {
      /* Invalid bootstrap never reaches the renderer. */
    }
    return;
  }
  const raw = event.data;
  if (
    !raw ||
    raw.protocol !== 1 ||
    typeof raw.sessionId !== 'string' ||
    raw.sessionId.length > 128 ||
    typeof raw.requestId !== 'string' ||
    raw.requestId.length > 128 ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision! < 0 ||
    (raw.type !== 'design-render' && raw.type !== 'render')
  )
    return;
  if (raw.mode !== 'edit' && raw.mode !== 'interact') return;
  if (
    !raw.viewport ||
    !Number.isSafeInteger(raw.viewport.width) ||
    raw.viewport.width < 240 ||
    raw.viewport.width > 7680 ||
    !Number.isSafeInteger(raw.viewport.height) ||
    raw.viewport.height < 240 ||
    raw.viewport.height > 7680
  )
    return;
  try {
    if (raw.type === 'design-render') {
      const conversion = convertDesignToReact(raw.native, raw.rootIds);
      if (conversion.sourceHash !== raw.sourceHash || conversion.diagnostics.length)
        throw new Error(
          conversion.diagnostics.map((d) => d.path + ': ' + d.message).join('; ') ||
            'Native source identity mismatch',
        );
      receive?.({
        ...raw,
        type: 'render',
        document: conversion.document,
        conversion,
        conversions: [conversion],
      });
    } else {
      if (!Array.isArray(raw.nativeSources) || raw.nativeSources.length > 1)
        throw new Error('Bounded Host registration context required');
      const conversions = raw.nativeSources.map((native: unknown) =>
        convertDesignToReact(native as Parameters<typeof convertDesignToReact>[0]),
      );
      if (conversions.some((c: DesignReactConversion) => c.diagnostics.length))
        throw new Error('Invalid retained native publication');
      receive?.({ ...raw, document: loadReactUiDocument(raw.document), conversions });
    }
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
            code: 'design-preview-invalid',
            severity: 'error',
            path: '$.native',
            message: String(error).slice(0, 1024),
            recovery: 'Correct addressed native metadata; source is retained.',
          },
        ],
      },
      trustedOrigin,
    );
  }
});
function HostPreview() {
  useEffect(() => {
    hostReady = true;
    announceReady();
  }, []);
  const [request, setRequest] = useState<DesignRequest>();
  const [inputs, setInputs] = useState<Record<string, JsonValue>>({});
  const [status, setStatus] = useState('');
  const [submissions, setSubmissions] = useState(0);
  const accepted = useRef<{ session: string; revision: number } | undefined>(undefined);
  const failed = useRef('');
  const send = (
    value: Omit<ReactPreviewResponse, 'protocol' | 'sessionId' | 'requestId' | 'revision'>,
  ) => {
    if (request)
      parent.postMessage(
        {
          protocol: 1,
          sessionId: request.sessionId,
          requestId: request.requestId,
          revision: request.revision,
          ...value,
        },
        trustedOrigin,
      );
  };
  receive = (raw) => {
    if (raw.type !== 'render') return;
    if (
      accepted.current &&
      (accepted.current.session !== raw.sessionId || raw.revision <= accepted.current.revision)
    )
      return;
    try {
      const inspected = inspectReactUiDocument(raw.document);
      if (!inspected.document || inspected.diagnostics.length)
        throw new Error(inspected.diagnostics.map((d) => d.message).join('; '));
      const document = loadReactUiDocument(inspected.document);
      const resolution = referenceResolutionFor(document.environment.ref);
      if (!resolution) throw new Error('Pinned preview environment unavailable');
      accepted.current = { session: raw.sessionId, revision: raw.revision };
      // Native element previews align to their exact exterior box; page previews
      // keep the #24 environment's Host margin outside registered compositions.
      globalThis.document.body.style.padding = raw.conversion ? '0px' : '';
      setRequest({ ...raw, document });
      setInputs(document.fixture);
      setStatus('');
      setSubmissions(0);
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
              message: String(error).slice(0, 1024),
              recovery: 'Correct the composition or pinned runtime; input is retained.',
            },
          ],
        },
        trustedOrigin,
      );
    }
  };
  useEffect(() => {
    if (request && failed.current !== request.requestId)
      send({
        type: 'ready',
        resolution: request.conversions.reduce(
          (resolution, c) => designReactResolution(c, resolution),
          referenceDesignOriginalResolution(
            request.conversions,
            referenceResolutionFor(request.document.environment.ref)!,
          ),
        ),
      } as Parameters<typeof send>[0]);
  }, [request]);
  const viewRuntime = useMemo(
    () =>
      request
        ? request.conversions.reduce(
            (current, c) => nativeDesignRuntime(c, current, request.viewport.width),
            {
              ...runtime,
              components: {
                ...runtime.components,
                ...referenceReviewedCardFunctions(
                  request.conversions,
                  components.Card as unknown as ComponentType<Record<string, unknown>>,
                ),
              },
              resolution: referenceDesignOriginalResolution(
                request.conversions,
                referenceResolutionFor(request.document.environment.ref)!,
              ),
            },
          )
        : undefined,
    [request],
  );
  if (!request || !viewRuntime) return <p>Waiting for composition</p>;
  return (
    <ReactPreviewBoundary
      key={request.requestId}
      onError={(diagnostics) => {
        failed.current = request.requestId;
        send({ type: 'error', diagnostics } as Parameters<typeof send>[0]);
      }}
    >
      <div data-preview-mode={request.mode}>
        <ReactComposition
          document={request.document}
          runtime={viewRuntime}
          width={request.viewport.width}
          inputs={inputs}
          mode={request.mode}
          select={(nodeId) => send({ type: 'selection', nodeId } as Parameters<typeof send>[0])}
          callback={(nodeId, event, args) => {
            const node = request.document.nodes.find((n) => n.id === nodeId)!;
            const registration = request.document.components.find(
              (c) => reactComponentKey(c.ref) === reactComponentKey(node.component),
            )!;
            const pair = registration.controlledInputs.find((p) => p.eventProp === event);
            const binding = pair && node.bindings[pair.valueProp];
            if (pair && binding?.kind === 'data') {
              const update = (value: JsonValue, path: string[]): JsonValue =>
                path.length
                  ? {
                      ...(value as Record<string, JsonValue>),
                      [path[0]]: update(
                        (value as Record<string, JsonValue>)[path[0]],
                        path.slice(1),
                      ),
                    }
                  : args[pair.argumentIndex];
              setInputs((current) => ({
                ...current,
                [binding.input]: update(
                  current[binding.input] ?? request.document.inputs[binding.input].default!,
                  binding.path,
                ),
              }));
            }
            setStatus(
              `${node.bindings[event]?.kind === 'callback' ? node.bindings[event].callback : event}: ${args.join(',') || 'called'}`,
            );
            if (
              node.bindings[event]?.kind === 'callback' &&
              node.bindings[event].callback === 'onBuy'
            ) {
              setInputs((current) => ({
                ...current,
                title: `Thanks ${current.name || 'visitor'}`,
              }));
              setSubmissions((count) => count + 1);
              setStatus(`Submitted ${submissions + 1}`);
            }
            send({ type: 'callback', nodeId, event, arguments: args } as Parameters<
              typeof send
            >[0]);
          }}
        />
        <p id="app-status" aria-live="polite">
          {status}
        </p>
      </div>
    </ReactPreviewBoundary>
  );
}
createRoot(document.getElementById('root')!).render(<HostPreview />);
