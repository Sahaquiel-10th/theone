import type { BubbleKind, EyeOwner } from './types';

export const EYE_ATTENTION_DURATION_MS = 20_000;
export interface EyeAttentionOptions {
  onChange?: (state: { owner: EyeOwner }) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  durationMs?: number;
}

/** The eye's short visit is independent of the child panel's lifetime. */
export function createEyeAttention({
  onChange = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  durationMs = EYE_ATTENTION_DURATION_MS,
}: EyeAttentionOptions = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('Eye attention duration must be a positive finite number.');
  }
  let owner: EyeOwner = 'main';
  let timer: unknown = null;
  let generation = 0;
  let disposed = false;
  const snapshot = () => ({ owner });
  function clearTimer() {
    generation++;
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function setOwner(next: EyeOwner) {
    if (owner === next) return;
    owner = next;
    onChange(snapshot());
  }
  return {
    snapshot,
    activate(kind: BubbleKind) {
      if (disposed) return snapshot();
      clearTimer();
      const visit = generation;
      timer = schedule(() => {
        if (disposed || visit !== generation) return;
        timer = null;
        generation++;
        setOwner('main');
      }, durationMs);
      setOwner(kind);
      return snapshot();
    },
    release(kind: EyeOwner) {
      if (disposed || owner !== kind || owner === 'main') return snapshot();
      clearTimer();
      setOwner('main');
      return snapshot();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
    },
  };
}
