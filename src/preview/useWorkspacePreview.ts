import { useEffect, useReducer } from 'react';
import { initialPreview, previewReducer } from './dispatchPreviewState';

export function useWorkspacePreview() {
 const enabled = import.meta.env.DEV && location.pathname === '/output/playwright/focus-preview.html' && new URLSearchParams(location.search).get('dispatchPreview') === '1';
 const [state, dispatch] = useReducer(previewReducer, undefined, initialPreview);
 useEffect(() => {
  if (!enabled) return;
  const timer = window.setInterval(() => {
   const now = Date.now();
   if (state.pending && now >= state.pending.dueAt) dispatch({ type: 'ack', id: state.pending.id, now });
   if (!state.manual) for (const task of state.tasks) if (task.dueAt !== null && now >= task.dueAt) dispatch({ type: 'finish', taskId: task.id, round: task.round, now });
  }, 200);
  return () => clearInterval(timer);
 }, [enabled, state.pending, state.tasks, state.manual,state.draft,state.notices]);
 return { enabled, state, dispatch };
}
