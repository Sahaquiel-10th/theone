import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

/** Clickable and keyboard-accessible explanation, not a hover-only tooltip. */
export function InfoHint({label,children}:{label:string;children:ReactNode}) {
  return <details className="one-info-hint"><summary aria-label={label} title={label}><Info size={15}/></summary><div>{children}</div></details>;
}
