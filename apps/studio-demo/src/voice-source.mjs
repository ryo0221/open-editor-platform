export const voiceSource = `import React, {useEffect, useRef, useState} from 'react';

// SORA Voice: 単一ファイルで再利用できる音声認識の試作。
// 音声処理は対応ブラウザーの認識サービスを利用します。
// 未対応・マイクなしでもサンプルで操作を確認できます。
type VoiceResult = {results: ArrayLike<{0: {transcript: string}}>};
type VoiceService = {
  lang: string; continuous: boolean; interimResults: boolean;
  onstart: (() => void) | null; onend: (() => void) | null;
  onresult: ((event: VoiceResult) => void) | null;
  onerror: ((event: {error: string}) => void) | null;
  start(): void; stop(): void; abort(): void;
};
type VoiceWindow = Window & {
  SpeechRecognition?: new () => VoiceService;
  webkitSpeechRecognition?: new () => VoiceService;
};
export default function SoraVoice() {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState('声から、次の一歩へ。');
  const recognition = useRef<VoiceService | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { recognition.current?.abort(); clearTimeout(timer.current); }, []);
  function start() {
    clearTimeout(timer.current);
    const voiceWindow = window as VoiceWindow;
    const API = voiceWindow.SpeechRecognition || voiceWindow.webkitSpeechRecognition;
    if (!API) { setMessage('このブラウザーは音声認識に未対応です。サンプル再生をお試しください。'); return; }
    const service = new API();
    service.lang = 'ja-JP'; service.continuous = true; service.interimResults = true;
    const original = text;
    service.onstart = () => {setRecording(true);setMessage('録音中。話してみてください。');};
    service.onresult = event => {
      let result = '';
      for (let i = 0; i < event.results.length; i++) result += event.results[i][0].transcript;
      setText(original + (original ? '\\n' : '') + result);
    };
    service.onerror = event => {setRecording(false);setMessage('音声認識: ' + event.error + '。サンプル再生でも試せます。');};
    service.onend = () => {setRecording(false);setMessage('入力を停止しました。文字起こしを自由に編集できます。');};
    recognition.current = service;
    try {service.start();} catch (error) {setMessage(error instanceof Error ? error.message : String(error));}
  }
  function sample() {
    recognition.current?.abort(); clearTimeout(timer.current); setRecording(false); setText('');
    const parts = ['SORA Voiceの企画を進めましょう。', 'まずは顧客ヒアリングで、会議の記録に関する課題を確かめます。', '次のアクションは、音声認識の試作を5人に触ってもらうことです。'];
    let i = 0; setMessage('サンプル文字起こしを表示中…');
    const step = () => {setText(parts.slice(0, ++i).join('\\n')); if (i < parts.length) timer.current = window.setTimeout(step, 600); else setMessage('サンプル完了。文字起こしを編集できます。');};
    step();
  }
  return <main style={{maxWidth:720,margin:'0 auto',padding:'46px 32px',fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif',color:'#183a33'}}>
    <div style={{fontSize:12,letterSpacing:3,color:'#718477'}}>SORA LAB / VOICE PROTOTYPE</div>
    <h1 style={{fontSize:56,letterSpacing:-3,lineHeight:1.1,margin:'24px 0 18px'}}>話す。整う。<br/>動き出す。</h1>
    <p style={{color:'#718477',fontSize:16,lineHeight:1.8}}>会話も、ひらめきも。あなたの声を、使える言葉に。</p>
    <div style={{display:'flex',gap:9,flexWrap:'wrap',margin:'30px 0 22px'}}>
      <button onClick={recording?()=>recognition.current?.stop():start} style={{background:'#183a33',color:'white',border:0,borderRadius:30,padding:'14px 22px',cursor:'pointer'}}>{recording?'■ 入力を停止':'● マイクで入力'}</button>
      <button onClick={sample} style={{background:'#e7eee2',color:'#183a33',border:0,borderRadius:30,padding:'14px 22px',cursor:'pointer'}}>▷ サンプル再生</button>
      <button onClick={()=>{recognition.current?.abort();clearTimeout(timer.current);setText('');setRecording(false);setMessage('クリアしました。');}} style={{border:0,background:'transparent',padding:'14px 12px',cursor:'pointer'}}>クリア</button>
    </div>
    <div role="status" style={{fontSize:13,color:recording?'#a13d26':'#6f8071',minHeight:22}}>{message}</div>
    <textarea aria-label="文字起こし" value={text} onChange={e=>setText(e.target.value)} placeholder="文字起こしがここに表示されます。直接入力・編集もできます。" style={{boxSizing:'border-box',width:'100%',minHeight:215,resize:'vertical',marginTop:16,padding:22,font:'16px/1.9 sans-serif',color:'#183a33',background:'#f4f7ef',border:'1px solid #e1e8dc',borderRadius:16}}/>
    <p style={{fontSize:12,color:'#819080',lineHeight:1.8}}>認識精度と利用可否はブラウザー・端末に依存します。<br/>音声を使う際はブラウザーの認識サービスの利用条件をご確認ください。</p>
  </main>;
}
`;
