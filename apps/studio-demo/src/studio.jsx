import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createArtifact } from '@editor-platform/artifact-core';
import { isDeck } from '@editor-platform/slide/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { HostApp, download } from '@editor-platform/reference-artifact-host';
import {
  BrowserArtifactStorage,
  productDesign,
  isCode,
} from '@editor-platform/reference-artifact-host/model';
import { soraDeck, soraCanvas, soraTasks, validTasks } from './samples';
import { voiceSource } from './voice-source.mjs';
import { CodeHost } from './code-host.jsx';
import { migrateTasks } from './tasks-data';
import './studio.css';
function initialArtifacts() {
  const warnings = [];
  function old(key, valid, factory) {
    try {
      const text = localStorage.getItem(key);
      if (!text) return factory();
      const data = JSON.parse(text);
      if (!valid(data)) throw Error('旧データの形式が不正');
      return data;
    } catch (e) {
      warnings.push(
        key + ': ' + e.message + '。旧データは変更せず、新しいサンプルを別の保存領域で開きます。',
      );
      return factory();
    }
  }
  let source = voiceSource;
  try {
    const saved = localStorage.getItem('ep-code-voice-v1');
    if (saved) {
      const test = {
        schemaVersion: 1,
        domain: 'host-code',
        fileId: 'sora-voice',
        filename: 'SoraVoice.tsx',
        source: saved,
      };
      if (!isCode(test)) throw Error('旧Codeのサイズ・形式が不正');
      source = saved;
    }
  } catch (e) {
    warnings.push(e.message + '。旧ソースは保持しています。');
  }
  const seeds = [
    ['sora-slide', 'slide', 'SORA企画書', old('ep-native-slide-v1', isDeck, soraDeck)],
    [
      'sora-whiteboard',
      'whiteboard',
      'ビジネスモデルキャンバス',
      old('ep-native-whiteboard-v1', isWhiteboard, soraCanvas),
    ],
    ['sora-design', 'design', '製品サイト', productDesign('話す。整う。動き出す。')],
    [
      'sora-code',
      'code',
      '音声認識ソフト',
      {
        schemaVersion: 1,
        domain: 'host-code',
        fileId: 'sora-voice',
        filename: 'SoraVoice.tsx',
        source,
      },
    ],
    ['sora-data', 'data', '開発タスク', migrateTasks(old('ep-kanban-v1', validTasks, soraTasks))],
  ];
  return {
    artifacts: seeds.map(([id, kind, name, content]) => ({
      ...createArtifact(kind, name, content),
      id,
    })),
    warnings,
  };
}
class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <div className="studio-failure" role="alert">
        <h2>この画面を開けませんでした。</h2>
        <p>{this.state.error.message}</p>
        <button onClick={() => location.reload()}>再読み込み</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export function Studio() {
  return (
    <Boundary>
      <StudioContent />
    </Boundary>
  );
}
function StudioContent() {
  const [initial] = useState(initialArtifacts),
    [help, setHelp] = useState(false);
  const storage = useMemo(() => new BrowserArtifactStorage(localStorage, 'ep-sora-artifact:'), []);
  const legacyReact = localStorage.getItem('ep-react-studio-v1');
  const header = (
    <>
      <header className="studio-header">
        <span className="studio-brand">
          <span className="studio-brand-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          Editor Platform<span>v2.3</span>
        </span>
        <div className="studio-project">
          <span>SORA LAB</span>
          <b>ひとつの構想。いくつものかたち。</b>
        </div>
        <div className="studio-header-right">
          <button onClick={() => setHelp(true)} className="studio-help">
            使い方 ↗
          </button>
        </div>
      </header>
      {initial.warnings.map((w) => (
        <p key={w} role="alert" className="studio-error">
          {w}
        </p>
      ))}
      {legacyReact && (
        <p className="studio-hint">
          以前のReact構想データは別形式として保持しています。新しい製品サイトはnative
          Designから編集します。
          <button onClick={() => download('legacy-react-prototype.json', legacyReact)}>
            旧Reactデータを退避
          </button>
        </p>
      )}
      {help && (
        <div className="studio-modal-backdrop">
          <section
            className="studio-modal"
            role="dialog"
            aria-modal="true"
            aria-label="デモサイトの使い方"
          >
            <h2>成果物から、編集してアプリへ。</h2>
            <p>
              一覧で5つの成果物を開き、保存してアプリに戻れます。保存した製品サイトは生成Reactでアプリ内に表示します。
            </p>
            <p>
              編集を保持して戻る場合、Session・Undo/Redoはこのタブに残ります。取消で破棄を選ぶとSessionを閉じます。ページ再読み込みは保存内容から始まり、履歴は新しくなります。
            </p>
            <p>
              SlideとWhiteboardは本体Surface、React/Designはnative
              Designと本体変換API、KanbanはDataの同じレコードをGridでも表示します。CodeはHostが所有するTSX編集・隔離実行です。共同編集・サーバー保存・Office出力は含みません。
            </p>
            <p>
              閲覧範囲はSites/Hostが管理します。この静的デモはライブの共有設定を取得できないため、Hostでの確認を案内します。ブラウザー保存は公開範囲を意味しません。
            </p>
            <button className="studio-primary" onClick={() => setHelp(false)}>
              編集を始める
            </button>
          </section>
        </div>
      )}
    </>
  );
  return (
    <Boundary>
      <HostApp
        samples={initial.artifacts}
        storage={storage}
        previewDocument={__ARTIFACT_PREVIEW_DOCUMENT__}
        codeSurface={(host) => <CodeHost host={host} />}
        header={header}
      />
    </Boundary>
  );
}
if (typeof document !== 'undefined' && document.getElementById('root'))
  createRoot(document.getElementById('root'), {
    onCaughtError() {
      /* Boundary displays the startup/render failure and recovery action. */
    },
  }).render(<Studio />);
