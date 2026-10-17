import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReturnTypeOfCompile } from './types';
type PreviewProps = {
  project: ReturnTypeOfCompile;
  previewDocument: string;
  title: string;
};
export function PreviewFrame(props: PreviewProps) {
  const execution = useMemo(() => crypto.randomUUID(), [props.project]);
  return <PreviewExecution key={execution} {...props} />;
}
function PreviewExecution({ project, previewDocument, title }: PreviewProps) {
  const frame = useRef<HTMLIFrameElement>(null),
    token = useRef(crypto.randomUUID()),
    revision = useRef(0);
  const [error, setError] = useState('');
  const current = useRef(project);
  current.current = project;
  const render = () => {
    revision.current++;
    frame.current?.contentWindow?.postMessage(
      {
        channel: 'artifact-host',
        type: 'render',
        token: token.current,
        revision: revision.current,
        ...current.current,
      },
      '*',
    );
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const d = event.data;
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== 'null' ||
        d?.channel !== 'artifact-preview' ||
        d.token !== token.current ||
        d.revision !== revision.current
      )
        return;
      if (d.type === 'error') setError(String(d.message).slice(0, 2048));
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      token.current = crypto.randomUUID();
    };
  }, []);
  return (
    <div className="host-preview">
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts"
        srcDoc={previewDocument}
        onLoad={render}
      />
      {error && <p role="alert">{error} — ソースは保持されています。</p>}
    </div>
  );
}
