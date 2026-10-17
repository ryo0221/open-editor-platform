import React, { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import { compileSource } from './compiler.mjs';
import { voiceSource } from './voice-source.mjs';
import { download } from '@editor-platform/reference-artifact-host';
import { domainExecute, isCode, codeSource } from '@editor-platform/reference-artifact-host/model';
export function CodeHost({ host }) {
  const source = host.snapshot.content.source;
  const setSource = (value) => {
    try {
      domainExecute(host, isCode)(codeSource(value));
    } catch (e) {
      setError(e.message);
    }
  };
  const [compiled, setCompiled] = useState(() => {
      try {
        return compileSource(source).code;
      } catch {
        return '';
      }
    }),
    [generation, setGeneration] = useState(0),
    [error, setError] = useState(''),
    [status, setStatus] = useState('サンプル再生またはマイク入力で体験'),
    [micRequest, setMicRequest] = useState(false),
    [transcript, setTranscript] = useState('');
  const frame = useRef(null),
    recognition = useRef(null),
    token = useRef('code-' + crypto.randomUUID()),
    area = useRef(null),
    caret = useRef([0, 0]);
  const currentGeneration = useRef(generation),
    currentCode = useRef(compiled),
    awaitingRender = useRef(true);
  currentGeneration.current = generation;
  currentCode.current = compiled;
  const post = (data) =>
    frame.current?.contentWindow?.postMessage(
      {
        channel: 'ep-code-host',
        token: token.current,
        generation: currentGeneration.current,
        ...data,
      },
      '*',
    );
  useEffect(() => {
    const receive = (e) => {
      const d = e.data;
      if (
        e.source !== frame.current?.contentWindow ||
        e.origin !== 'null' ||
        d?.channel !== 'ep-code-preview'
      )
        return;
      if (d.type === 'ready') {
        if (awaitingRender.current) {
          awaitingRender.current = false;
          post({ type: 'render', code: currentCode.current });
        }
        return;
      }
      if (d.token !== token.current || d.generation !== currentGeneration.current) return;
      if (d.type === 'request-microphone') setMicRequest(true);
      if (d.type === 'stop-microphone') {
        setMicRequest(false);
        recognition.current?.abort();
      }
      if (d.type === 'error') {
        try {
          setError(String(d.message).slice(0, 2048));
        } catch {
          setError('Invalid preview error payload');
        }
      }
      if (d.type === 'transcript') setTranscript(String(d.text).slice(0, 100000));
    };
    window.addEventListener('message', receive);
    post({ type: 'connect' });
    return () => {
      window.removeEventListener('message', receive);
      recognition.current?.abort();
    };
  }, []);
  function run() {
    host.flushInputs();
    stopRecognition();
    setMicRequest(false);
    try {
      const result = compileSource(source, 'SoraVoice.tsx');
      if (!result.hasDefault) throw Error('React Componentをdefault exportしてください');
      awaitingRender.current = true;
      setCompiled(result.code);
      setGeneration(++currentGeneration.current);
      setError('');
      setStatus('コードを実行しました');
    } catch (e) {
      setError(e.message);
    }
  }
  function stopRecognition() {
    const service = recognition.current;
    recognition.current = null;
    service?.abort();
  }
  function microphone() {
    setMicRequest(false);
    const API = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!API) {
      post({ type: 'speech', event: 'error', error: 'このブラウザーは音声認識に未対応です' });
      setStatus('サンプル再生をご利用ください');
      return;
    }
    stopRecognition();
    const service = new API();
    const serviceGeneration = currentGeneration.current;
    recognition.current = service;
    const current = () =>
      recognition.current === service && currentGeneration.current === serviceGeneration;
    const speech = (data) => {
      if (current()) post({ type: 'speech', generation: serviceGeneration, ...data });
    };
    service.lang = 'ja-JP';
    service.continuous = true;
    service.interimResults = true;
    service.onstart = () => {
      if (!current()) return;
      speech({ event: 'start' });
      setStatus('マイク入力中');
    };
    service.onresult = (e) =>
      speech({
        event: 'result',
        results: Array.from(e.results, (r) => ({
          text: r[0].transcript,
          confidence: r[0].confidence,
          final: r.isFinal,
        })),
      });
    service.onend = () => {
      if (!current()) return;
      speech({ event: 'end' });
      setStatus('マイク入力を停止');
    };
    service.onerror = (e) => {
      if (!current()) return;
      speech({ event: 'error', error: e.error });
      setStatus('マイク入力: ' + e.error + '。サンプル再生でも試せます。');
    };
    try {
      service.start();
    } catch (e) {
      setError(e.message);
    }
  }
  async function zip() {
    const z = new JSZip();
    z.file('SoraVoice.tsx', source);
    z.file('transcript.txt', transcript);
    z.file(
      'package.json',
      JSON.stringify(
        {
          name: 'sora-voice',
          private: true,
          dependencies: { react: '19.1.1', 'react-dom': '19.1.1' },
        },
        null,
        2,
      ),
    );
    z.file(
      'README.md',
      '# SORA Voice\n\nSoraVoice.tsxのdefault exportをReactアプリで使用してください。音声認識はwindow.SpeechRecognition / webkitSpeechRecognitionを利用します。対応ブラウザーとHTTPSが必要です。ユーザーがマイク入力ボタンを押した後にブラウザーへ許可を要求します。未対応環境でもサンプル再生を使用できます。\n',
    );
    const blob = await z.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = 'sora-voice-react.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Reactソースと文字起こしを出力しました');
  }
  return (
    <section className="code-workbench" aria-label="音声認識ソフトのCodeエディタ">
      <div className="studio-document-bar">
        <div>
          <span className="studio-dot" />
          <strong>SORA Voice / 音声認識ソフト</strong>
          <span className="studio-tag">Host拡張・共通Session</span>
        </div>
        <div className="studio-tools">
          <button onClick={() => download('SoraVoice.tsx', source, 'text/plain')}>TSX保存</button>
          <button
            onClick={() => download('sora-transcript.txt', transcript, 'text/plain')}
            disabled={!transcript}
          >
            文字起こし保存
          </button>
          <button onClick={zip}>React ZIP出力</button>
          <button className="studio-primary" onClick={run}>
            ▷ 実行
          </button>
        </div>
      </div>
      <div className="studio-hint">
        <span>
          左のReactコードを編集 → 実行 → 右で操作。マイクなしでも「サンプル再生」を試せます。
        </span>
        <button
          disabled={host.snapshot.readOnly}
          onClick={() => {
            host.flushInputs();
            setSource(voiceSource);
            host.flushInputs();
            awaitingRender.current = true;
            setCompiled(compileSource(voiceSource).code);
            setGeneration(++currentGeneration.current);
            setError('');
            stopRecognition();
            setMicRequest(false);
          }}
        >
          サンプルに戻す
        </button>
      </div>
      <div className="code-columns">
        <div className="code-source-pane">
          <div className="code-pane-title">
            <span className="code-file">◈ SoraVoice.tsx</span>
            <span>React · TypeScript</span>
          </div>
          <div className="code-editor-wrap">
            <pre aria-hidden="true" className="code-line-numbers">
              {source
                .split('\n')
                .map((_, i) => i + 1)
                .join('\n')}
            </pre>
            <textarea
              ref={area}
              className="studio-code-editor"
              aria-label="音声認識Reactソース"
              value={source}
              readOnly={host.snapshot.readOnly}
              maxLength={150000}
              spellCheck="false"
              onSelect={(e) => {
                const next = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd];
                if (next.some((value, i) => value !== caret.current[i])) host.breakHistoryGroup();
                caret.current = next;
              }}
              onBlur={() => host.flushInputs()}
              onChange={(e) => {
                caret.current = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd];
                setSource(e.target.value);
              }}
              onScroll={(e) =>
                (e.currentTarget.previousSibling.scrollTop = e.currentTarget.scrollTop)
              }
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !host.snapshot.readOnly) {
                  e.preventDefault();
                  const el = e.currentTarget,
                    a = el.selectionStart,
                    b = el.selectionEnd;
                  setSource(source.slice(0, a) + '  ' + source.slice(b));
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = a + 2;
                  });
                }
              }}
            />
          </div>
        </div>
        <div className="code-output-pane">
          <div className="code-pane-title">
            <span>
              <i className="studio-dot" />
              Live preview
            </span>
            <span>実行して反映</span>
          </div>
          <iframe
            key={generation}
            ref={frame}
            title="SORA音声認識プレビュー"
            sandbox="allow-scripts"
            srcDoc={__CODE_DOCUMENT__}
            onLoad={() => post({ type: 'connect' })}
          />
        </div>
      </div>
      {error && (
        <pre className="studio-error code-error" role="alert">
          {error}
        </pre>
      )}
      <div className="studio-status" role="status">
        <span>● {status}</span>
        <span>編集はHost Sessionに保持 · アプリに戻る前に保存 · 外部importはReactのみ</span>
      </div>
      {micRequest && (
        <div className="studio-modal-backdrop">
          <section
            className="studio-modal"
            role="dialog"
            aria-modal="true"
            aria-label="マイク入力の開始"
          >
            <span className="studio-eyebrow">VOICE INPUT</span>
            <h2>あなたの声で、試してみる。</h2>
            <p>
              音声認識には対応ブラウザーの認識サービスを使用します。開始するとブラウザーがマイクの許可を求めます。録音ファイルはこのサイトに保存しません。
            </p>
            <div className="studio-tools">
              <button
                onClick={() => {
                  setMicRequest(false);
                  post({ type: 'speech', event: 'error', error: 'マイク入力をキャンセルしました' });
                }}
              >
                キャンセル
              </button>
              <button className="studio-primary" onClick={microphone}>
                マイク入力を開始
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
