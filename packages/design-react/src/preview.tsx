import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignContent } from '@editor-platform/design/model';
import { convertDesignToReact } from '@editor-platform/design-react-core';
import {
  validateReactPreviewEndpoint,
  validateReactPreviewBootstrap,
  validateReactPreviewResponse,
  type ReactRuntimeAdapter,
} from '@editor-platform/react-ui-core';
export function DesignReactPreview({
  content,
  rootIds,
  runtime,
  width,
  height,
  mode = 'edit',
}: {
  content: DesignContent;
  rootIds: string[];
  runtime: ReactRuntimeAdapter;
  width: number;
  height: number;
  mode?: 'edit' | 'interact';
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useRef(crypto.randomUUID()),
    revision = useRef(0);
  const [status, setStatus] = useState('Loading React preview');
  const [readyRequest, setReadyRequest] = useState('');
  const roots = rootIds.join('\0');
  const projection = useMemo(() => {
    try {
      return { conversion: convertDesignToReact(content, roots.split('\0')) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [content, roots]);
  const conversion = projection.conversion;
  const endpoint = useMemo(() => {
    if (!content.web) return;
    const original = runtime.previewEndpoint(content.web.environment.ref);
    return validateReactPreviewEndpoint(location.origin, original, content.web.environment.ref);
  }, [runtime, content.web?.environment.ref]);
  const request = useMemo(
    () => ({
      protocol: 1 as const,
      type: 'design-render',
      sessionId: session.current,
      requestId: crypto.randomUUID(),
      revision: ++revision.current,
      native: content,
      sourceHash: conversion?.sourceHash,
      rootIds: roots.split('\0'),
      mode,
      viewport: {
        width: Math.max(240, Math.round(width)),
        height: Math.max(240, Math.round(height)),
      },
    }),
    [content, conversion, roots, width, height, mode],
  );
  useEffect(() => {
    if (!endpoint || !conversion || conversion.diagnostics.length) return;
    let ready = false,
      resolved = false;
    const controller = new AbortController();
    const post = () => {
      if (ready && resolved) frame.current?.contentWindow?.postMessage(request, endpoint.origin);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== endpoint.origin) return;
      try {
        if (event.data?.type === 'host-ready') {
          validateReactPreviewBootstrap(
            event,
            { source: frame.current.contentWindow!, origin: endpoint.origin },
            'host-ready',
          );
          ready = true;
          post();
          return;
        }
        const response = validateReactPreviewResponse(event, {
          source: frame.current.contentWindow!,
          origin: endpoint.origin,
          sessionId: request.sessionId,
          requestId: request.requestId,
          revision: request.revision,
          document: conversion.document,
          mode,
        });
        if (response.type === 'ready') {
          setStatus('React preview ready');
          setReadyRequest(request.requestId);
        }
        if (response.type === 'error')
          setStatus(response.diagnostics.map((d) => `${d.path}: ${d.message}`).join('; '));
        if (response.type === 'callback')
          setStatus(`Callback ${response.event}: ${response.arguments.join(',') || 'called'}`);
      } catch {
        /* Foreign, stale and malformed messages cannot edit native content. */
      }
    };
    window.addEventListener('message', receive);
    setStatus('Loading React preview');
    runtime
      .resolve({
        environment: content.web!.environment.ref,
        components: conversion.document.components
          .filter((c) => c.ref.registryId !== 'native-design')
          .map((c) => c.ref),
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.resolution || result.diagnostics.length)
          setStatus(
            result.diagnostics.map((d) => d.message).join('; ') || 'Pinned runtime unavailable',
          );
        else {
          resolved = true;
          frame.current?.contentWindow?.postMessage(
            { protocol: 1, type: 'host-ready-request' },
            endpoint.origin,
          );
          post();
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatus(String(error));
      });
    return () => {
      controller.abort();
      window.removeEventListener('message', receive);
    };
  }, [request, endpoint, conversion, runtime, mode, content]);
  if (!endpoint || !conversion || conversion.diagnostics.length)
    return (
      <div role="alert">
        {projection.error ??
          conversion?.diagnostics.map((d) => `${d.path}: ${d.message}`).join('; ') ??
          'Configure a pinned React environment'}
      </div>
    );
  return (
    <div className="design-react-preview" style={{ width, height }} data-preview-status={status}>
      <iframe
        aria-busy={readyRequest !== request.requestId}
        ref={frame}
        title={`Design React preview ${roots}`}
        src={`${endpoint.url}${endpoint.url.includes('?') ? '&' : '?'}parentOrigin=${encodeURIComponent(location.origin)}`}
        sandbox="allow-scripts allow-same-origin"
        style={{
          width: '100%',
          height: '100%',
          border: 0,
          display: 'block',
          pointerEvents: mode === 'edit' ? 'none' : 'auto',
        }}
        onLoad={() =>
          frame.current?.contentWindow?.postMessage(
            { protocol: 1, type: 'host-ready-request' },
            endpoint.origin,
          )
        }
      />
      {status !== 'React preview ready' && (
        <span role="status" style={{ fontSize: 11 }}>
          {status}
        </span>
      )}
    </div>
  );
}
