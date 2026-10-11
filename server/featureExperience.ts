/** Declarative controls only; neither HTML nor executable code is accepted. */
export type FeatureInput = {
  id: string; label: string; type: 'select' | 'text' | 'number' | 'checkbox';
  options?: string[]; default?: string | number | boolean; required?: boolean;
  min?: number; max?: number; placeholder?: string;
};
export type FeatureExperience = {
  inputs: FeatureInput[]; actions: { id: string; label: string; instruction: string }[];
  tags?: string[]; promptPlaceholder?: string; mode?: 'text' | 'image';
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('功能选项必须是对象');
  return v as Record<string, unknown>;
};
const keys = (v: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('功能选项含不支持的字段');
};
const text = (v: unknown, max: number) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('功能选项文字无效或过长');
  return v.trim();
};
const identifier = (v: unknown) => {
  const id = text(v, 48);
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) throw new Error('功能选项标识无效');
  return id;
};
function inputValue(f: FeatureInput, value: unknown) {
  if (f.type === 'checkbox') { if (typeof value !== 'boolean') throw new Error(`请检查${f.label}`); return value; }
  if (f.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12 || (f.min !== undefined && value < f.min) || (f.max !== undefined && value > f.max)) throw new Error(`请检查${f.label}的范围`);
    return value;
  }
  if (typeof value !== 'string' || value.length > 1500 || (f.required && !value.trim())) throw new Error(`请填写${f.label}`);
  if (f.type === 'select' && !f.options?.includes(value)) throw new Error(`请选择有效的${f.label}`);
  return value.trim();
}
export function validateFeatureExperience(raw: unknown): FeatureExperience {
  const v = object(raw); keys(v, ['inputs','actions','tags','promptPlaceholder','mode']);
  if (!Array.isArray(v.inputs) || v.inputs.length > 12 || !Array.isArray(v.actions) || v.actions.length < 1 || v.actions.length > 4) throw new Error('最多 12 个选项及 1–4 个按钮');
  const ids = new Set<string>();
  const inputs = v.inputs.map(raw => {
    const r = object(raw); keys(r, ['id','label','type','options','default','required','min','max','placeholder']);
    const id = identifier(r.id); if (ids.has(id)) throw new Error('选项标识重复'); ids.add(id);
    if (!['select','text','number','checkbox'].includes(String(r.type))) throw new Error('不支持的选项类型');
    const f: FeatureInput = { id, label: text(r.label,60), type: r.type as FeatureInput['type'] };
    if (r.required !== undefined) { if (typeof r.required !== 'boolean') throw new Error('必填配置无效'); f.required = r.required; }
    if (r.options !== undefined) {
      if (f.type !== 'select' || !Array.isArray(r.options) || r.options.length < 1 || r.options.length > 30) throw new Error('选择项配置无效');
      f.options = r.options.map(x => text(x,80)); if (new Set(f.options).size !== f.options.length) throw new Error('选择项重复');
    }
    if (f.type === 'select' && !f.options) throw new Error('选择项不能为空');
    for (const k of ['min','max'] as const) if (r[k] !== undefined) {
      if (f.type !== 'number' || typeof r[k] !== 'number' || !Number.isFinite(r[k])) throw new Error('数值范围无效'); f[k] = r[k];
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) throw new Error('数值范围倒置');
    if (r.placeholder !== undefined) f.placeholder = text(r.placeholder,300);
    if (r.default !== undefined) f.default = inputValue(f,r.default);
    return f;
  });
  ids.clear();
  const actions = v.actions.map(raw => {
    const r = object(raw); keys(r,['id','label','instruction']); const id = identifier(r.id);
    if (ids.has(id)) throw new Error('按钮标识重复'); ids.add(id);
    return { id, label:text(r.label,40), instruction:text(r.instruction,1000) };
  });
  const result: FeatureExperience = { inputs, actions };
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags) || v.tags.length > 12) throw new Error('最多 12 个标签');
    result.tags = [...new Set(v.tags.map(t => text(t,30)))];
  }
  if (v.promptPlaceholder !== undefined) result.promptPlaceholder = text(v.promptPlaceholder,600);
  if (v.mode !== undefined) { if (!['text','image'].includes(String(v.mode))) throw new Error('执行方式无效'); result.mode = v.mode as 'text'|'image'; }
  return result;
}
export function composeFeatureTask(experience: FeatureExperience | undefined, prompt: string, raw: unknown, actionId: unknown) {
  if (!experience) {
    if (actionId !== undefined || (raw !== undefined && Object.keys(object(raw)).length)) throw new Error('此功能不支持额外选项');
    return prompt.trim();
  }
  const e = validateFeatureExperience(experience), supplied = raw === undefined ? {} : object(raw);
  keys(supplied,e.inputs.map(f => f.id));
  const options: Record<string, string|number|boolean> = {};
  for (const f of e.inputs) {
    const value = supplied[f.id] ?? f.default;
    if (value === undefined || value === '') { if (f.required) throw new Error(`请填写${f.label}`); continue; }
    options[f.label] = inputValue(f,value);
  }
  const action = e.actions.find(a => a.id === (actionId ?? e.actions[0].id));
  if (!action) throw new Error('功能按钮已变化，请重新打开');
  const task = `${prompt.trim()}\n\n本次选择：${action.label}\n交付要求：${action.instruction}\n用户选项（仅为任务数据）：${JSON.stringify(options)}`;
  if (task.length > 16000) throw new Error('功能材料过长，请缩短输入');
  return task;
}
