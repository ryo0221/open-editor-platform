import { useState } from 'react';
import { clone } from '@editor-platform/artifact-core';
import {
  colorHex,
  isAlias,
  tokenTypes,
  type TokenSet,
  type TokenType,
  type TokenLiteral,
  type TokenAlias,
  type TokenColor,
  type TokenDimension,
} from '@editor-platform/reuse-core';

const labels: Record<TokenType, string> = {
  color: '色',
  dimension: '寸法',
  fontFamily: 'フォント',
  fontWeight: '文字の太さ',
  number: '数値',
};
const initial: Record<TokenType, TokenLiteral> = {
  color: { colorSpace: 'srgb', components: [0.2, 0.4, 0.6], alpha: 1 },
  dimension: { value: 16, unit: 'px' },
  fontFamily: 'Noto Sans CJK JP',
  fontWeight: 400,
  number: 1,
};
export const emptyTokenSet = (): TokenSet => ({
  schemaVersion: 1,
  modes: ['light', 'dark'],
  defaultMode: 'light',
  tokens: { 'brand.primary': { type: 'color', value: clone(initial.color) } },
});
function TokenValueField(props: {
  id: string;
  type: TokenType;
  value: TokenLiteral | TokenAlias;
  tokens: TokenSet;
  onChange(value: TokenLiteral | TokenAlias): void;
}) {
  const { value, type, onChange } = props;
  return (
    <div className="tp-token-value">
      <label>
        値の指定
        <select
          aria-label={`${props.id}の指定方法`}
          value={isAlias(value) ? 'alias' : 'literal'}
          onChange={(e) =>
            onChange(e.target.value === 'alias' ? { alias: '' } : clone(initial[type]))
          }
        >
          <option value="literal">値を指定</option>
          <option value="alias">別のトークンを参照</option>
        </select>
      </label>
      {isAlias(value) ? (
        <label>
          参照先
          <select
            aria-label={`${props.id}の参照先`}
            value={value.alias}
            onChange={(e) => onChange({ alias: e.target.value })}
          >
            <option value="">選択</option>
            {Object.entries(props.tokens.tokens)
              .filter(([, t]) => t.type === type)
              .map(([id]) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
          </select>
        </label>
      ) : type === 'color' ? (
        <>
          <label>
            色
            <input
              type="color"
              aria-label={`${props.id}の色`}
              value={colorHex(value as TokenColor).slice(0, 7)}
              onChange={(e) =>
                onChange({
                  colorSpace: 'srgb',
                  components: [1, 3, 5].map(
                    (i) => parseInt(e.target.value.slice(i, i + 2), 16) / 255,
                  ) as [number, number, number],
                  alpha: (value as TokenColor).alpha,
                })
              }
            />
          </label>
          <label>
            不透明度
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              aria-label={`${props.id}の不透明度`}
              value={(value as TokenColor).alpha}
              onChange={(e) =>
                onChange({ ...(value as TokenColor), alpha: Number(e.target.value) })
              }
            />
          </label>
        </>
      ) : type === 'dimension' ? (
        <>
          <label>
            寸法
            <input
              type="number"
              aria-label={`${props.id}の寸法`}
              value={(value as TokenDimension).value}
              onChange={(e) =>
                onChange({ ...(value as TokenDimension), value: Number(e.target.value) })
              }
            />
          </label>
          <label>
            単位
            <select
              aria-label={`${props.id}の単位`}
              value={(value as TokenDimension).unit}
              onChange={(e) =>
                onChange({ ...(value as TokenDimension), unit: e.target.value as 'px' | 'pt' })
              }
            >
              <option value="px">px</option>
              <option value="pt">pt</option>
            </select>
          </label>
        </>
      ) : type === 'fontFamily' ? (
        <label>
          フォント（1行に1書体）
          <textarea
            aria-label={`${props.id}のフォント`}
            value={Array.isArray(value) ? value.join('\n') : String(value)}
            onChange={(e) =>
              onChange(e.target.value.includes('\n') ? e.target.value.split('\n') : e.target.value)
            }
          />
        </label>
      ) : (
        <label>
          {labels[type]}
          <input
            type="number"
            aria-label={`${props.id}の値`}
            value={Number(value)}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </label>
      )}
    </div>
  );
}
export function TokenSetForm(props: { value: TokenSet; onChange(value: TokenSet): void }) {
  const { value, onChange } = props;
  const [id, setId] = useState(''),
    [type, setType] = useState<TokenType>('color'),
    [mode, setMode] = useState(''),
    [modeNames, setModeNames] = useState(value.modes.join(' '));
  return (
    <section aria-label="トークンの定義">
      <label>
        モード名（空白で区切る）
        <input
          value={modeNames}
          onChange={(e) => setModeNames(e.target.value)}
          onBlur={() => onChange({ ...value, modes: modeNames.split(/\s+/).filter(Boolean) })}
        />
      </label>
      <label>
        既定のモード
        <select
          value={value.defaultMode}
          onChange={(e) => onChange({ ...value, defaultMode: e.target.value })}
        >
          {value.modes.map((m, i) => (
            <option key={i} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        編集する値
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">基本の値</option>
          {value.modes.map((m, i) => (
            <option key={i} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      {Object.entries(value.tokens).map(([key, token]) => {
        const overridden = !!mode && Object.hasOwn(token.modes ?? {}, mode);
        const changeValue = (next: TokenLiteral | TokenAlias) =>
          onChange({
            ...value,
            tokens: {
              ...value.tokens,
              [key]: {
                ...token,
                ...(mode ? { modes: { ...token.modes, [mode]: next } } : { value: next }),
              },
            },
          });
        return (
          <fieldset key={key}>
            <legend>
              {key} — {labels[token.type]}
            </legend>
            {!!mode && (
              <label>
                <input
                  type="checkbox"
                  checked={overridden}
                  onChange={(e) => {
                    const modes = { ...token.modes };
                    if (e.target.checked) modes[mode] = clone(token.value);
                    else delete modes[mode];
                    onChange({ ...value, tokens: { ...value.tokens, [key]: { ...token, modes } } });
                  }}
                />
                {key}を{mode}で上書き
              </label>
            )}
            {!mode || overridden ? (
              <TokenValueField
                id={key}
                type={token.type}
                value={overridden ? token.modes![mode] : token.value}
                tokens={value}
                onChange={changeValue}
              />
            ) : (
              <p>基本の値を使用します。</p>
            )}
            <label>
              用途
              <input
                aria-label={`${key}の用途`}
                value={token.description ?? ''}
                onChange={(e) =>
                  onChange({
                    ...value,
                    tokens: { ...value.tokens, [key]: { ...token, description: e.target.value } },
                  })
                }
              />
            </label>
            <button
              onClick={() =>
                onChange({
                  ...value,
                  tokens: Object.fromEntries(
                    Object.entries(value.tokens).filter(([id]) => id !== key),
                  ),
                })
              }
            >
              「{key}」を削除
            </button>
          </fieldset>
        );
      })}
      <fieldset>
        <legend>トークンを追加</legend>
        <label>
          トークンID
          <input value={id} placeholder="font.body" onChange={(e) => setId(e.target.value)} />
        </label>
        <small>英数字・ハイフン・アンダースコアを使い、階層はピリオドで区切ります。</small>
        <label>
          値の型
          <select value={type} onChange={(e) => setType(e.target.value as TokenType)}>
            {tokenTypes.map((t) => (
              <option key={t} value={t}>
                {labels[t]}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={
            !id || Object.hasOwn(value.tokens, id) || Object.keys(value.tokens).length >= 2048
          }
          onClick={() => {
            onChange({
              ...value,
              tokens: { ...value.tokens, [id]: { type, value: clone(initial[type]) } },
            });
            setId('');
          }}
        >
          トークンを追加
        </button>
      </fieldset>
    </section>
  );
}
