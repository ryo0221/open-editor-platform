/**
 * Who owns role=status where the Surface is placed (#563). A Host that shows its own status
 * passes `statusRole="none"`: the Surface's notices keep `aria-live="polite"` and drop the role,
 * so the Host's status stays the only one in its frame.
 */
import { createContext, useContext } from 'react';

export type EstimateStatusRole = 'status' | 'none';
export const StatusRoleContext = createContext<EstimateStatusRole>('status');

/** Props for a notice: role=status named "見積の状態", or only a polite live region. */
export function useStatusProps() {
  return useContext(StatusRoleContext) === 'status'
    ? ({ role: 'status', 'aria-label': '見積の状態' } as const)
    : ({ 'aria-live': 'polite' } as const);
}
