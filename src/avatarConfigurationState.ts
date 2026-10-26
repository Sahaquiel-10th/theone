import type { AvatarAvailableFeature, AvatarServiceConfig } from './AvatarService';
export const AVATAR_METHOD_LIMIT = 12000;
export const AVATAR_FEATURE_LIMIT = 4;
/** Goal changes preserve every authored field and never grant permissions. */
export function avatarWithMode(value: AvatarServiceConfig, mode: AvatarServiceConfig['mode']): AvatarServiceConfig { return { ...value, mode }; }
/** Imports append; never silently replace an author's existing materials. */
export function appendAvatarMethod(existing: string, imported: string): string {
    const addition = imported.replace(/^\uFEFF/, '').trim();
    if (!addition) throw new Error('这份文档没有可导入的文字，请换一份文档。');
    const method = existing.trim() ? `${existing.trimEnd()}\n\n${addition}` : addition;
    if (method.length > AVATAR_METHOD_LIMIT) throw new Error('导入后资料会超过 12000 字。原内容没有改动，请精简文档或现有资料后再导入。');
    return method;
}
export function avatarFeatureSelected(value: AvatarServiceConfig, feature: AvatarAvailableFeature): boolean { return value.features.some(choice => choice.featureId === feature.id && choice.releaseId === feature.releaseId); }
export function avatarWithFeature(value: AvatarServiceConfig, feature: AvatarAvailableFeature, selected: boolean): AvatarServiceConfig {
    const exists = avatarFeatureSelected(value, feature);
    if (selected === exists || (selected && value.features.length >= AVATAR_FEATURE_LIMIT)) return value;
    return { ...value, features: selected ? [...value.features, { featureId: feature.id, releaseId: feature.releaseId, when: '', workflow: '' }] : value.features.filter(choice => choice.featureId !== feature.id || choice.releaseId !== feature.releaseId) };
}
/** Suggestions only reorder available choices, never select a tool. */
export function avatarFeatureSuggestions(features: AvatarAvailableFeature[], mode: AvatarServiceConfig['mode']): AvatarAvailableFeature[] {
    const pattern = mode === 'consultation' ? /需求|咨询|测算|预算|表单|评估/ : /文档|方案|表格|网页|报告|知识/;
    return features.map((feature, index) => ({ feature, index, suggested: pattern.test(`${feature.name} ${feature.description}`) })).sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.index - b.index).slice(0, 3).map(item => item.feature);
}
