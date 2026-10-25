export type FluidPanelKind = 'activity' | 'local';

export const FLUID_PANEL_IDLE_MS = 180_000;
/** Let the last note finish its return flight before reclaiming reading space. */
export const FLUID_TASK_RETURN_MS = 1_200;

export interface FluidPanelSnapshot {
  activityOpen: boolean;
  localOpen: boolean;
}

export interface FluidPanelInputs {
  enabled: boolean;
  activitySignal: string;
  localSignal: string;
  activityProtected: boolean;
  localProtected: boolean;
  activityReported?: boolean;
}

interface PanelState {
  open: boolean;
  signal: string;
  protected: boolean;
  editing: boolean;
  timer: unknown;
  generation: number;
}

export interface PanelLifetimeOptions {
  idleMs?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
  onChange?: (snapshot: FluidPanelSnapshot) => void;
  /** Signal is supplied only for automatic reveals; explicit opens omit it. */
  onAttention?: (kind: FluidPanelKind, signal?: string) => void;
  onAutoCollapse?: (kind: FluidPanelKind) => void;
}

/** Visibility only. Closing a panel never changes or cancels its underlying task. */
export function createPanelLifetime(options: PanelLifetimeOptions = {}) {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const idleMs = options.idleMs ?? FLUID_PANEL_IDLE_MS;
  const createState = (): PanelState => ({
    open: false, signal: '', protected: false, editing: false, timer: null, generation: 0,
  });
  const panels: Record<FluidPanelKind, PanelState> = {
    activity: createState(), local: createState(),
  };
  let enabled = false;
  let disposed = false;
  let lastSnapshot: FluidPanelSnapshot = { activityOpen: false, localOpen: false };

  const snapshot = (): FluidPanelSnapshot => ({
    activityOpen: panels.activity.open,
    localOpen: panels.local.open,
  });

  function notify() {
    const next = snapshot();
    if (next.activityOpen === lastSnapshot.activityOpen && next.localOpen === lastSnapshot.localOpen) return;
    lastSnapshot = next;
    options.onChange?.(next);
  }

  function clearTimer(panel: PanelState) {
    panel.generation += 1;
    if (panel.timer !== null) cancel(panel.timer);
    panel.timer = null;
  }

  function arm(kind: FluidPanelKind, delay = idleMs) {
    const panel = panels[kind];
    clearTimer(panel);
    if (disposed || !enabled || !panel.open || panel.protected || panel.editing) return;
    const generation = panel.generation;
    panel.timer = schedule(() => {
      if (disposed || !enabled || generation !== panel.generation || !panel.open || panel.protected || panel.editing) return;
      panel.timer = null;
      // Move focus before its current control disappears. Reentrant activity can
      // renew the timer, in which case this old deadline must not hide the panel.
      options.onAutoCollapse?.(kind);
      if (disposed || !enabled || generation !== panel.generation || !panel.open || panel.protected || panel.editing) return;
      clearTimer(panel);
      panel.open = false;
      notify();
    }, delay);
  }

  function reveal(kind: FluidPanelKind, signal?: string) {
    if (disposed || !enabled) return;
    panels[kind].open = true;
    arm(kind);
    notify();
    options.onAttention?.(kind, signal);
  }

  function setInputs(inputs: FluidPanelInputs) {
    if (disposed) return;
    if (!inputs.enabled) {
      enabled = false;
      for (const kind of ['activity', 'local'] as const) {
        const panel = panels[kind];
        clearTimer(panel);
        panel.open = false;
        panel.signal = '';
        panel.editing = false;
        panel.protected = inputs[`${kind}Protected`];
      }
      notify();
      return;
    }

    enabled = true;
    for (const kind of ['activity', 'local'] as const) {
      const panel = panels[kind];
      const protection = inputs[`${kind}Protected`];
      const protectionChanged = protection !== panel.protected;
      panel.protected = protection;
      const signal = inputs[`${kind}Signal`];
      const signalChanged = signal !== panel.signal;
      panel.signal = signal;
      if (signalChanged && signal !== '') reveal(kind, signal);
      else if (kind === 'activity' && signalChanged && !signal && inputs.activityReported)
        arm(kind, FLUID_TASK_RETURN_MS);
      else if (protectionChanged) arm(kind);
    }
  }

  function toggle(kind: FluidPanelKind) {
    if (disposed || !enabled) return;
    const panel = panels[kind];
    if (!panel.open) {
      reveal(kind);
      return;
    }
    clearTimer(panel);
    panel.editing = false;
    panel.open = false;
    notify();
  }

  function interact(kind: FluidPanelKind) {
    if (disposed || !enabled || !panels[kind].open) return;
    arm(kind);
  }

  function protectEditing(kind: FluidPanelKind, editing: boolean) {
    if (disposed || panels[kind].editing === editing) return;
    panels[kind].editing = editing;
    arm(kind);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const panel of Object.values(panels)) clearTimer(panel);
  }

  return { snapshot, setInputs, toggle, open: reveal, interact, protectEditing, dispose };
}
