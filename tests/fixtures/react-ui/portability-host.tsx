import type { ReactNode } from 'react';

/** Independent trusted Host fixture. Deliberately does not accept className. */
export function Panel({
  title,
  body,
  action,
  onPick,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  onPick?: (choice: 'open' | 'done') => void;
}) {
  return (
    <section aria-label="Portable panel">
      <h1>{title}</h1>
      <p>{body ?? 'Default body'}</p>
      {action ?? <button onClick={() => onPick?.('open')}>Default action</button>}
      <p>{action ? 'Custom action' : 'Absent action'}</p>
    </section>
  );
}
