import { type EditorWordingSet } from '@editor-platform/editor-ui';

/**
 * Visible wording of the Whiteboard Surface. Shared controls (insert tools, arrange, canvas
 * controls, visual inspector) bring their own wording from editor-ui and canvas-ui.
 */
export const whiteboardWording: EditorWordingSet = {
  ja: {
    'Board navigator': 'ボードの一覧',
    'Board inspector': '設定',
    Dismiss: '閉じる',
    // Toolbar
    'Add sticky': '付箋を追加',
    'Draw Section': 'Section を描く',
    'Freehand pen': 'ペン',
    'Connect selected': '選んだ 2 つをつなぐ',
    'Select two nodes': '2 つ選ぶとつなげます',
    'Board actions': 'ボードの操作',
    'Section around selected objects': '選んだものを Section で囲む',
    'Fit all content': '全体を表示',
    'Fit selection': '選択に合わせて表示',
    'Camera center x': '表示の中心 x',
    'Camera center y': '表示の中心 y',
    'Export whiteboard': '書き出す',
    'Export all {0}': '全体を {0} で書き出す',
    'Export selection {0}': '選択を {0} で書き出す',
    'Export section {0}': 'Section を {0} で書き出す',
    // Navigator
    Sections: 'Section',
    'Sections organize objects. Resize changes the region only.':
      'Section はものをまとめます。大きさを変えても範囲だけが変わります。',
    Overview: '全体図',
    Connections: 'つながり',
    'Connection {0}': 'つながり {0}',
    // Status
    '{0} nodes · {1} Sections · {2} connections': '{0} 個 · Section {1} · つながり {2}',
    'Fit board': 'ボード全体を表示',
    // Section inspector
    Section: 'Section',
    'Section title': '題',
    'Section background': '背景の色',
    'Section x': 'x',
    'Section y': 'y',
    'Section width': '幅',
    'Section height': '高さ',
    '{0} members · no clipping': '{0} 個 · はみ出しは切らない',
    'Dissolve Section': 'Section を解く',
    'Delete Section and contents': 'Section と中身を消す',
    'Export Section SVG': 'Section を SVG で書き出す',
    // Connector inspector
    Connector: 'つながり',
    'Connector label': 'ラベル',
    Routing: '線の引き方',
    straight: 'まっすぐ',
    elbow: '折れ線',
    curve: '曲線',
    'Connector stroke': '線の色',
    'Connector width (px)': '線の太さ (px)',
    Arrowheads: '矢印',
    none: 'なし',
    end: '終わり',
    both: '両方',
    'from node': 'つなぐ元',
    'to node': 'つなぐ先',
    'from port': '元の port',
    'to port': '先の port',
    'Free endpoint': 'どこにもつながない',
    auto: '自動',
    top: '上',
    right: '右',
    bottom: '下',
    left: '左',
    'Delete connector': 'つながりを消す',
    'Drag an endpoint onto a node edge to attach it. Dropping on empty space makes it a free endpoint. Deleting a connected node removes incident connectors; Undo restores them.':
      '端をものの縁に運ぶとつながります。何もない所に落とすと、どこにもつながない端になります。つながったものを消すと、そのつながりも消えます。元に戻すと戻ります。',
    // Membership
    Membership: '入っている Section',
    'Outside Sections': 'どの Section にも入れない',
    // Errors
    'Choose a Group outside this subtree': 'この中に入っていない Group を選んでください',
    'Select nodes within a Section for region-relative alignment':
      'Section を基準に揃えるには、Section の中のものを選んでください',
    'Use Section actions for this region; grouping and scaling apply to objects.':
      'Section には Section の操作を使ってください。まとめる・拡大縮小はものに使えます。',
    'Copy board content first': '先にボードの中身をコピーしてください',
    'Select objects or a Section first': '先にものか Section を選んでください',
    'This board is too large for a full-size PNG. Export a Section or SVG.':
      'ボードが大きすぎて、そのままの大きさの PNG にできません。Section か SVG で書き出してください。',
  },
  en: {
    // Port editor (source text is Japanese)
    接続port: 'Connection ports',
    'port名: {0}': 'Port name: {0}',
    'portの辺: {0}': 'Port side: {0}',
    'portの位置 (0–1): {0}': 'Port position (0–1): {0}',
    'portを削除: {0}': 'Delete port: {0}',
    'この図の接続で使用中です。先に接続先を変更してください。':
      'A connection on this board uses it. Change the connection first.',
    接続portを追加: 'Add connection port',
    '参照付きの出力には参照接続が必要です。':
      'An export with references needs a reference connection.',
    '取得中に参照接続が変わりました。再実行してください。':
      'The reference connection changed while loading. Try again.',
    '取得中に入力が変わりました。再実行してください。':
      'The input changed while loading. Try again.',
  },
};
