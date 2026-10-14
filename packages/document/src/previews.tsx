import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
export function MermaidPreview({ source }: { source: string }) {
  const [result, setResult] = useState<{ svg?: string; error?: string }>({});
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
            setResult({ svg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
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
    <img className="diagram" src={result.svg} alt="Mermaid diagram" />
  ) : (
    <p className="muted">Rendering diagram…</p>
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
