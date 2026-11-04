/**
 * Who owns role=status where the Surface is placed (#563). A Host that shows its own status
 * passes `statusRole="none"`: the Surface's notices keep `aria-live="polite"` and drop the role,
 * so the Host's status stays the only one in its frame.
 */
import { createContext, useContext, type ComponentProps } from 'react';

export type CadStatusRole = 'status' | 'none';
export const StatusRoleContext = createContext<CadStatusRole>('status');
export const statusName = 'CAD の状態';

/** Props for a notice: a named role=status, or only a polite live region. */
export function useStatusProps(name = statusName) {
  return useContext(StatusRoleContext) === 'status'
    ? ({ role: 'status', 'aria-label': name } as const)
    : ({ 'aria-live': 'polite' } as const);
}

/** `<output>` is implicitly role=status; with "none" it reads the same without the role. */
export function Output({ children, ...props }: ComponentProps<'output'>) {
  return useContext(StatusRoleContext) === 'status' ? (
    <output {...props}>{children}</output>
  ) : (
    <output {...props} role="none">
      <span aria-live="polite">{children}</span>
    </output>
  );
}
