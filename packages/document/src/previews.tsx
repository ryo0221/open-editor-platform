import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
/** The diagram's own width in CSS px, from the viewBox Mermaid writes. */
export function mermaidWidth(svg: string): number | undefined {
  const box = /viewBox="[-\d.e]+[ ,]+[-\d.e]+[ ,]+([\d.e]+)[ ,]+[\d.e]+"/.exec(svg);
  const width = box ? Number(box[1]) : NaN;
  return width > 0 ? width : undefined;
}
export function MermaidPreview({ source }: { source: string }) {
  const [result, setResult] = useState<{ svg?: string; width?: number; error?: string }>({});
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { default: mermaid } = await import('mermaid');
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'neutral',
            suppressErrorRendering: true,
          });
          const valid = await mermaid.parse(source, { suppressErrors: true });
          if (!valid) {
            if (active) setResult({ error: 'Invalid Mermaid syntax. Your other blocks are safe.' });
            return;
          }
          const { svg } = await mermaid.render(`diagram-${crypto.randomUUID()}`, source);
          if (active)
            setResult({
              svg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
              width: mermaidWidth(svg),
            });
        } catch {
          if (active) setResult({ error: 'Unable to render this Mermaid diagram.' });
        }
      })();
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [source]);
  return result.error ? (
    <p role="status" className="error">
      {result.error}
    </p>
  ) : result.svg ? (
    <DiagramFrame src={result.svg} width={result.width} />
  ) : (
    <p className="muted">Rendering diagram…</p>
  );
}

/**
 * Shows a diagram at its own size, scrolling sideways when wider than the page;
 * only such a diagram offers Fit to width. The choice is view state, not content.
 */
function DiagramFrame({ src, width }: { src: string; width?: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number>();
  const [fit, setFit] = useState(false);
  useEffect(() => {
    const element = frame.current!;
    const measure = () => setRoom(element.clientWidth);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  const wide = !!width && !!room && width > room;
  return (
    <div className="ep-diagram">
      {wide && (
        <div className="ep-diagram-tools" role="group" aria-label="Diagram size">
          <button aria-pressed={fit} onClick={() => setFit(true)}>
            Fit to width
          </button>
          <button aria-pressed={!fit} onClick={() => setFit(false)}>
            Actual size
          </button>
        </div>
      )}
      <div
        ref={frame}
        className="ep-diagram-scroll"
        role={wide && !fit ? 'region' : undefined}
        aria-label={wide && !fit ? 'Mermaid diagram, scroll sideways' : undefined}
        tabIndex={wide && !fit ? 0 : undefined}
      >
        <img
          className="diagram"
          src={src}
          alt="Mermaid diagram"
          data-size={fit || !width ? 'fit' : 'actual'}
          style={fit || !width ? undefined : { width, maxWidth: 'none', maxHeight: 'none' }}
        />
      </div>
    </div>
  );
}

export function HtmlPreview({ source }: { source: string }) {
  const sanitized = DOMPurify.sanitize(source, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'],
    FORBID_ATTR: ['onerror', 'onload'],
  });
  const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"><style>body{font:16px/1.6 sans-serif;padding:12px}</style>${sanitized}`;
  return <iframe title="Sandboxed HTML preview" sandbox="" srcDoc={html} />;
}
