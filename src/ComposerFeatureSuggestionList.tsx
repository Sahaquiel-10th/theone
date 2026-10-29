import { Check, Plus, X } from 'lucide-react';
import type { FeatureChoice } from './preview/FeatureShelf';
import type { ComposerFeatureSuggestion } from './composerFeatureSuggestionMatch';

/* Intent: the author keeps typing while optionally adding a relevant capability.
 * Hierarchy: their draft stays primary; three small, optional choices sit above it.
 * Palette/depth/surfaces: existing ONE glass menu, ink, muted text and yellow focus.
 * Typography/spacing: inherited face, 12/11 px title/summary, 4 px rhythm, no motion.
 */
export function ComposerFeatureSuggestionList({ items, selected, onChoose, onDismiss }: {
  items: readonly ComposerFeatureSuggestion[];
  selected: readonly string[];
  onChoose: (feature: FeatureChoice, source?: HTMLElement) => void;
  onDismiss: () => void;
}) {
  if (!items.length) return null;
  return <section className="composer-feature-suggestions" aria-label="输入相关的功能">
    <header><span>可添加功能 <small>仅下一条消息使用</small></span><button type="button" className="composer-feature-suggestions-dismiss" aria-label="忽略本次功能推荐" onMouseDown={event => event.preventDefault()} onClick={onDismiss}><X size={15} aria-hidden="true" /></button></header>
    <ul>{items.map(({ feature }) => {
      const added = selected.includes(feature.id), full = !added && selected.length >= 8;
      return <li key={feature.id}><button type="button" className="composer-feature-suggestion" aria-pressed={added} aria-label={`${added ? '已添加功能' : '添加功能'}：${feature.name}`} disabled={added || full} title={full ? '每条消息最多使用 8 个功能' : undefined} onMouseDown={event => event.preventDefault()} onClick={event => { if (!selected.includes(feature.id) && selected.length < 8) onChoose(feature, event.currentTarget); }}>
        <span><strong>{feature.name}</strong><small>{feature.description}</small></span>{added ? <Check size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
      </button></li>;
    })}</ul>
  </section>;
}
