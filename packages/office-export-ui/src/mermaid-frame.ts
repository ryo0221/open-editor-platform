import type { DocxJobResponse, MermaidSvg } from './docx-protocol';

/** A disposable DOM/layout renderer. Only the trusted frame script handles Mermaid source. */
export function renderOfficeMermaidFrame(
  url: string,
  input: Extract<DocxJobResponse, { status: 'render-mermaid' }>,
  signal: AbortSignal,
): Promise<MermaidSvg> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe'),
      key = crypto.randomUUID();
    let finished = false;
    let dispatchTimer: number | undefined;
    frame.title = 'Office diagram rendering';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.sandbox.add('allow-scripts', 'allow-same-origin');
    frame.style.cssText =
      'position:fixed;left:-100000px;top:0;width:1200px;height:900px;border:0;pointer-events:none';
    const address = new URL(url, location.href);
    frame.src = address.href;
    const finish = (result?: MermaidSvg, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(dispatchTimer);
      window.removeEventListener('message', message);
      signal.removeEventListener('abort', abort);
      frame.remove();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(undefined, new DOMException('Export cancelled', 'AbortError'));
    const message = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== address.origin ||
        event.data?.key !== key
      )
        return;
      if (event.data.type === 'office-mermaid-result') finish(event.data.result);
      else if (event.data.type === 'office-mermaid-error')
        finish(undefined, Error(event.data.message));
    };
    const timeout = setTimeout(
      () => finish(undefined, Error('Mermaid rendering exceeded its time limit')),
      15000,
    );
    window.addEventListener('message', message);
    signal.addEventListener('abort', abort, { once: true });
    frame.addEventListener('load', () => {
      // WebKit attributes a synchronous iframe-load postMessage to the child
      // Window. Dispatch in the owner's next task so the frame's strict parent
      // source/origin check works consistently; cancellation clears this task.
      dispatchTimer = window.setTimeout(() => {
        if (finished) return;
        frame.contentWindow?.postMessage(
          {
            type: 'office-mermaid-render',
            key,
            source: input.source,
            manifest: input.manifest,
            files: input.files,
          },
          address.origin,
        );
      }, 0);
    });
    frame.onerror = () =>
      finish(undefined, Error('The Office diagram renderer could not be loaded'));
    if (signal.aborted) abort();
    else document.body.append(frame);
  });
}
