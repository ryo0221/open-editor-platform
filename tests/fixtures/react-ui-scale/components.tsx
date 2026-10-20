import { createContext, useContext, type ReactNode } from 'react';

type Layout = { className?: string };
type Copy = Layout & { text: string };
type Container = Layout & { children?: ReactNode; footer?: ReactNode };
const Theme = createContext('missing');
export function ThemeProvider({ children }: { children?: ReactNode }) {
  return <Theme.Provider value="scale-light">{children}</Theme.Provider>;
}
export function Box({ children, footer, ...layout }: Container) {
  return (
    <main {...layout}>
      {children}
      {footer}
    </main>
  );
}
export function Section({ children, footer, ...layout }: Container) {
  return (
    <section {...layout}>
      {children}
      {footer}
    </section>
  );
}
export function Card({ children, footer, ...layout }: Container) {
  const theme = useContext(Theme);
  if (theme === 'missing') throw Error('Scale ThemeProvider is required');
  return (
    <article {...layout} data-theme={theme}>
      {children}
      <footer>{footer}</footer>
    </article>
  );
}
export function Text({ text, ...layout }: Copy) {
  return <p {...layout}>{text}</p>;
}
export function Heading({ text, ...layout }: Copy) {
  return <h2 {...layout}>{text}</h2>;
}
export function Button({ text, onPress, ...layout }: Copy & { onPress?: () => void }) {
  return (
    <button {...layout} onClick={() => onPress?.()}>
      {text}
    </button>
  );
}
export function Input({
  text,
  value,
  onChange,
  ...layout
}: Copy & { value: string; onChange?: (value: string) => void }) {
  return (
    <label {...layout}>
      {text}
      <input aria-label={text} value={value} onChange={(event) => onChange?.(event.target.value)} />
    </label>
  );
}
export function Image({ text, source, ...layout }: Copy & { source: string }) {
  return <img {...layout} src={source} alt={text} width="24" height="24" />;
}
export function Badge({ text, ...layout }: Copy) {
  return (
    <span {...layout} data-kind="badge">
      {text}
    </span>
  );
}
export function Link({ text, ...layout }: Copy) {
  return (
    <a {...layout} href="#scale">
      {text}
    </a>
  );
}
export function Divider({ text, ...layout }: Copy) {
  return <hr {...layout} aria-label={text} />;
}
export function Metric({ text, ...layout }: Copy) {
  return <output {...layout}>{text}</output>;
}
export function Notice({ text, ...layout }: Copy) {
  return <aside {...layout}>{text}</aside>;
}
export function Label({ text, ...layout }: Copy) {
  return (
    <span {...layout} data-kind="label">
      {text}
    </span>
  );
}
export function Progress({ text, ...layout }: Copy) {
  return <progress {...layout} aria-label={text} value="50" max="100" />;
}
export function Avatar({ text, ...layout }: Copy) {
  return (
    <span {...layout} role="img" aria-label={text}>
      A
    </span>
  );
}
export function Status({ text, ...layout }: Copy) {
  return (
    <span {...layout} data-kind="status">
      {text}
    </span>
  );
}
export function Code({ text, ...layout }: Copy) {
  return <code {...layout}>{text}</code>;
}
export function Quote({ text, ...layout }: Copy) {
  return <blockquote {...layout}>{text}</blockquote>;
}
export function Caption({ text, ...layout }: Copy) {
  return <small {...layout}>{text}</small>;
}
export function Tag({ text, ...layout }: Copy) {
  return <mark {...layout}>{text}</mark>;
}
