import { useCallback, useEffect, useRef, useState } from 'react';
import { createPanelLifetime } from './panelLifetime';
import type { FluidPanelInputs, FluidPanelKind, FluidPanelSnapshot } from './panelLifetime';

export type { FluidPanelKind } from './panelLifetime';

export interface UseFluidPanelsOptions extends FluidPanelInputs {
  onAttention?: (kind: FluidPanelKind) => void;
  onAutoCollapse?: (kind: FluidPanelKind) => void;
}

/** Three-minute panel visibility; the surface owns its separate eye handoff timer. */
export function useFluidPanels(options: UseFluidPanelsOptions) {
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<ReturnType<typeof createPanelLifetime> | null>(null);
  // Survives React Strict Mode's effect replay so it does not announce a signal
  // twice. Real signal changes, explicit opens and re-enabling remain actionable.
  const announced = useRef<Record<FluidPanelKind, string>>({ activity: '', local: '' });
  const [state, setState] = useState<FluidPanelSnapshot>({ activityOpen: false, localOpen: false });

  useEffect(() => {
    let active = true;
    const instance = createPanelLifetime({
      onChange: (next) => { if (active) setState(next); },
      onAttention: (kind, signal) => {
        if (!active) return;
        if (signal !== undefined) {
          if (announced.current[kind] === signal) return;
          announced.current[kind] = signal;
        }
        latest.current.onAttention?.(kind);
      },
      onAutoCollapse: (kind) => { if (active) latest.current.onAutoCollapse?.(kind); },
    });
    controller.current = instance;
    instance.setInputs(latest.current);
    return () => {
      active = false;
      instance.dispose();
      if (controller.current === instance) controller.current = null;
    };
  }, []);

  useEffect(() => {
    if (!options.enabled) announced.current = { activity: '', local: '' };
    else {
      if (!options.activitySignal) announced.current.activity = '';
      if (!options.localSignal) announced.current.local = '';
    }
    controller.current?.setInputs(options);
  }, [options.enabled, options.activitySignal, options.localSignal, options.activityProtected, options.localProtected]);

  const toggle = useCallback((kind: FluidPanelKind) => controller.current?.toggle(kind), []);
  const open = useCallback((kind: FluidPanelKind) => controller.current?.open(kind), []);
  const interact = useCallback((kind: FluidPanelKind) => controller.current?.interact(kind), []);
  const protectEditing = useCallback((kind: FluidPanelKind, editing: boolean) => controller.current?.protectEditing(kind, editing), []);

  return { ...state, toggle, open, interact, protectEditing };
}
