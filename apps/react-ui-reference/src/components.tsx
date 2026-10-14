import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
const Theme = createContext('missing');
export function ThemeProvider({ theme, children }: { theme: string; children?: ReactNode }) {
  return <Theme.Provider value={theme}>{children}</Theme.Provider>;
}
type Layout = { className?: string; style?: CSSProperties };
export function Card({
  children,
  footer,
  ...layout
}: Layout & { children?: ReactNode; footer?: ReactNode }) {
  const theme = useContext(Theme);
  if (theme === 'missing') throw new Error('ThemeProvider is required');
  return (
    <section {...layout} data-theme={theme} aria-label="Reference card">
      <div className="reference-body">{children}</div>
      <footer>{footer}</footer>
    </section>
  );
}
export function Button({
  label,
  variant = 'secondary',
  onPress,
  ...layout
}: Layout & { label: string; variant?: 'primary' | 'secondary'; onPress?: () => void }) {
  return (
    <button {...layout} data-variant={variant} onClick={() => onPress?.()}>
      {label}
    </button>
  );
}
export function Text({ text, ...layout }: Layout & { text: string }) {
  if (text === 'THROW_REFERENCE') throw new Error('Reference component exception');
  return <p {...layout}>{text}</p>;
}
export function Image({ source, alt, ...layout }: Layout & { source: string; alt: string }) {
  return <img {...layout} src={source} alt={alt} />;
}
export function Input({
  value,
  label = 'Name',
  onChange,
  ...layout
}: Layout & { value: string; label?: string; onChange?: (value: string) => void }) {
  return (
    <label {...layout}>
      {label}
      <input
        aria-label={label}
        maxLength={80}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  );
}
