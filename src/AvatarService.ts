export type AvatarFeatureChoice = {
    featureId: string;
    releaseId: string;
    when: string;
    workflow: string;
};
export type AvatarServiceConfig = {
    mode: 'consultation' | 'knowledge';
    welcome: string;
    starterQuestions: string[];
    method: string;
    features: AvatarFeatureChoice[];
};
export type AvatarAvailableFeature = {
    id: string;
    releaseId: string;
    name: string;
    description: string;
    usageMultiplier?: number;
};
export type AvatarPlanDraft = {
    id?: string;
    name: string;
    kind: 'monthly' | 'credits';
    quota: number;
    priceCny: number;
    validDays: number;
    status: 'active' | 'archived';
};
export type AvatarIntakeField = {
    id: string;
    label: string;
    type: 'text' | 'number' | 'email' | 'phone';
    required?: boolean;
};
export type AvatarBusinessConfig = {
    access: 'open' | 'entitlement';
    plans: AvatarPlanDraft[];
    intakeFields: AvatarIntakeField[];
};
export const emptyAvatarService = (): AvatarServiceConfig => ({ mode: 'consultation', welcome: '', starterQuestions: [], method: '', features: [] });
export const emptyAvatarBusiness = (): AvatarBusinessConfig => ({ access: 'open', plans: [], intakeFields: [] });
type AvatarBusinessInput = Partial<Omit<AvatarBusinessConfig, 'plans'>> & {plans?: (Omit<AvatarPlanDraft, 'quota'> & {quota?:number;quotaMicros?:number})[]};
export function normalizedAvatarBusiness(value?:AvatarBusinessInput):AvatarBusinessConfig {
    return {access:value?.access==='entitlement'?'entitlement':'open',plans:(value?.plans??[]).map(plan=>({id:plan.id,name:plan.name,kind:plan.kind,quota:plan.quota??(plan.quotaMicros??0)/1e6,priceCny:plan.priceCny,validDays:plan.validDays,status:plan.status})),intakeFields:value?.intakeFields??[]};
}
export function normalizedAvatarService(value?: Partial<AvatarServiceConfig>): AvatarServiceConfig {
    return { mode: value?.mode === 'knowledge' ? 'knowledge' : 'consultation', welcome: value?.welcome ?? '', starterQuestions: (value?.starterQuestions ?? []).slice(0, 4), method: value?.method ?? '', features: (value?.features ?? []).slice(0, 4) };
}
export function avatarServicePayload(value: AvatarServiceConfig): AvatarServiceConfig {
    return { ...value, welcome: value.welcome.trim(), starterQuestions: value.starterQuestions.map(q => q.trim()).filter(Boolean).slice(0, 4), features: value.features.map(f => ({ ...f, when: f.when.trim(), workflow: f.workflow.trim() })) };
}
export function avatarRunProgress(stage?: string): string {
    const stages: Record<string, string> = { accepted: '已收到，正在安排', preparing: '正在准备', retrieving: '正在查找相关资料', thinking: '正在整理回答', using_tools: '正在制作你需要的成果', tools: '正在制作你需要的成果', working: '正在处理', finishing: '正在核对成果', completed: '已完成' };
    return stages[stage ?? ''] ?? '正在处理，结果会留在这里';
}
export function avatarArtifactKind(mimeType: string): 'html' | 'image' | 'download' {
    if (mimeType.split(';')[0].trim() === 'text/html')
        return 'html';
    if (/^image\/(png|jpeg|webp|gif)$/.test(mimeType.split(';')[0].trim()))
        return 'image';
    return 'download';
}
export function avatarFileSize(size: number): string {
    return size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : size >= 1024 ? `${Math.ceil(size / 1024)} KB` : `${size} B`;
}
