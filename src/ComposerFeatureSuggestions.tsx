import { useEffect, useRef, useState } from 'react';
import type { api as Api } from './oneApi';
import type { FeatureChoice } from './preview/FeatureShelf';
import { composerSuggestionCatalogForScope, loadComposerFeatureSuggestionCatalog, matchComposerFeatureSuggestions, type ComposerSuggestionCatalog } from './composerFeatureSuggestionMatch';
import { ComposerFeatureSuggestionList } from './ComposerFeatureSuggestionList';
import './composer-feature-suggestions.css';

export type ComposerFeatureSuggestionsProps = {
  api: typeof Api;
  /** Exact current user + workspace identity; never a browser-supplied permission. */
  scopeKey: string;
  text: string;
  cursor?: number;
  enabled: boolean;
  focused: boolean;
  composing?: boolean;
  pickerOpen?: boolean;
  dismissVersion?: number;
  selected: readonly string[];
  onChoose: (feature: FeatureChoice, source?: HTMLElement) => void;
  onDismiss?: () => void;
};

type Dismissed = { api: typeof Api; scopeKey: string; key: string };

/** Passive suggestions deliberately have no keyboard handler: Enter sends the
 * message, and arrow keys keep editing. Explicit @ / + selection remains separate. */
export function ComposerFeatureSuggestions({ api, scopeKey, text, cursor = text.length, enabled, focused, composing = false, pickerOpen = false, dismissVersion = 0, selected, onChoose, onDismiss }: ComposerFeatureSuggestionsProps) {
  const [catalog, setCatalog] = useState<ComposerSuggestionCatalog | null>(null);
  const [dismissed, setDismissed] = useState<Dismissed | null>(null);
  const lastDismissVersion = useRef(dismissVersion);
  useEffect(() => {
    setCatalog(null);
    setDismissed(null);
    if (!enabled || !scopeKey) return;
    const abort = new AbortController();
    void loadComposerFeatureSuggestionCatalog(api, abort.signal).then(items => { if (!abort.signal.aborted) setCatalog({ api, scopeKey, items }); }).catch(() => { /* Optional discovery quietly falls back to +功能. */ });
    return () => abort.abort();
  }, [api, scopeKey, enabled]);
  // Identity comparisons hide old rows synchronously, before effect cleanup.
  const current = composerSuggestionCatalogForScope(catalog, api, scopeKey, enabled);
  const match = matchComposerFeatureSuggestions(current, text, cursor);
  useEffect(() => {
    if (lastDismissVersion.current !== dismissVersion) {
      lastDismissVersion.current = dismissVersion;
      setDismissed({ api, scopeKey, key: match.key });
    }
  }, [api, scopeKey, dismissVersion, match.key]);
  const ignored = dismissed?.api === api && dismissed.scopeKey === scopeKey && dismissed.key === match.key;
  if (!enabled || !scopeKey || !focused || composing || pickerOpen || ignored) return null;
  return <ComposerFeatureSuggestionList items={match.items} selected={selected} onChoose={onChoose} onDismiss={() => {setDismissed({ api, scopeKey, key: match.key });onDismiss?.();}} />;
}
