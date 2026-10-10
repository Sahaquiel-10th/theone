import JSZip from 'jszip';
import path from 'node:path';
import { FeatureConfigError } from './officialFeatures.js';

export const SKILL_UPLOAD_BYTES = 2 * 1024 * 1024;
const TEXT_BYTES = 128 * 1024;
export type SkillImport = { name: string; description: string; instructions: string; skillAttribution: string; files: string[]; warnings: string[] };

function text(bytes: Buffer): string {
  if (bytes.length > TEXT_BYTES) throw new FeatureConfigError('单个说明文件不能超过 128KB');
  try { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (value.includes('\0')) throw new Error();
    return value;
  } catch { throw new FeatureConfigError('说明文件必须是 UTF-8 文本'); }
}
// Read only simple top-level metadata. YAML tags, nested objects and commands
// never become configuration or runtime permissions.
function metadata(source: string, key: string): string {
  const lines = source.split('\n');
  const index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index < 0) return '';
  let value = lines[index].slice(key.length + 1).trim();
  if (/^[|>][-+]?$/.test(value)) {
    const rest: string[] = [];
    for (let i = index + 1; i < lines.length && (/^\s/.test(lines[i]) || !lines[i]); i++) rest.push(lines[i].trim());
    value = rest.join(value.startsWith('>') ? ' ' : '\n').trim();
  } else if (value.startsWith('"')) {
    try { value = JSON.parse(value); } catch { throw new FeatureConfigError('请检查 skill 的元信息引号'); }
  } else if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new FeatureConfigError('请检查 skill 的元信息引号');
    value = value.slice(1, -1).replace(/''/g, "'");
  } else {
    const rest: string[] = [];
    for (let i = index + 1; i < lines.length && lines[i] && !/^[a-zA-Z][\w-]*:/.test(lines[i]) && !/^\s/.test(lines[i]); i++) rest.push(lines[i].trim());
    if (rest.length) value += ' ' + rest.join(' ');
  }
  return typeof value === 'string' ? value : '';
}
function preview(source: string, files: Map<string, string>, mainFile: string): SkillImport {
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const instructions = match ? source.slice(match[0].length).trim() : source.trim();
  const name = match ? metadata(match[1], 'name') : (instructions.match(/^#\s+(.+)$/m)?.[1] ?? '待填写名称');
  const description = match ? metadata(match[1], 'description') : '请填写这个功能的用途和适用场景';
  if (!instructions || !name || !description) throw new FeatureConfigError('skill 需要名称、用途和执行说明');
  if (name.length > 60 || description.length > 500) throw new FeatureConfigError('名称最多 60 字，用途最多 500 字，请先整理 skill 元信息');
  const licenses = [...files].filter(([file]) => /(^|\/)(LICENSE|NOTICE)(\.(txt|md))?$/i.test(file));
  const references = [...files].filter(([file]) => file !== mainFile && /\.md$/i.test(file) && !/(^|\/)(LICENSE|NOTICE)\.md$/i.test(file));
  const combined = instructions + references.map(([file, value]) => `\n\n---\n参考文件：${file}\n${value}`).join('');
  if (combined.length > 12000) throw new FeatureConfigError('执行说明与参考资料合计超过 12000 字，请先拆分为独立技能；不会截断导入');
  const skillAttribution = [match ? `skill 声明的许可：${metadata(match[1], 'license') || '未声明'}` : 'skill 未声明许可', ...licenses.map(([file, value]) => `${file}\n${value}`)].join('\n\n');
  if (skillAttribution.length > 30000) throw new FeatureConfigError('许可与署名记录超过 30000 字');
  return { name, description, instructions: combined, skillAttribution, files: [...files.keys()], warnings: ['导入仅生成待编辑配置，不自动保存、认定或上架。', '请核对来源、作者、商用授权及依赖；上传文件不能增加工具权限。'] };
}

export async function importSkill(bytes: Buffer, filename: string): Promise<SkillImport> {
  if (!bytes.length || bytes.length > SKILL_UPLOAD_BYTES) throw new FeatureConfigError('skill 文件须为 1 字节至 2MB');
  if (/\.md$/i.test(filename)) return preview(text(bytes), new Map([[path.basename(filename), text(bytes)]]), path.basename(filename));
  if (!/\.zip$/i.test(filename)) throw new FeatureConfigError('请选择 .md 文件或 .zip 压缩包');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new FeatureConfigError('无法读取 ZIP 压缩包'); }
  const entries = Object.values(zip.files);
  if (entries.length > 100) throw new FeatureConfigError('压缩包最多包含 100 个条目，请只上传一个 skill');
  const files = new Map<string, string>();
  let total = 0;
  for (const entry of entries) {
    const original = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (/^[\/\\]|^[a-z]:|\\|\0/i.test(original) || original.split('/').includes('..')) throw new FeatureConfigError('压缩包包含不安全路径');
    if (entry.dir || /(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(entry.name)) continue;
    if (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0o170000) === 0o120000) throw new FeatureConfigError('压缩包不能包含符号链接');
    if (!/\.md$|(^|\/)(LICENSE|NOTICE)(\.(txt|md))?$/i.test(entry.name)) throw new FeatureConfigError(`文件 ${entry.name} 需要适配；当前仅导入说明、Markdown 参考资料和许可文件，不能直接运行脚本或素材包`);
    const stream = entry.nodeStream('nodebuffer');
    const chunks: Buffer[] = []; let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          const buffer = Buffer.from(chunk); size += buffer.length; total += buffer.length;
          if (size > TEXT_BYTES || total > 512 * 1024) { stream.pause(); reject(new FeatureConfigError('压缩包解压后的说明过大')); return; }
          chunks.push(buffer);
        }).on('error', reject).on('end', () => resolve()).resume();
      });
    } catch (error) { if (error instanceof FeatureConfigError) throw error; throw new FeatureConfigError('压缩包内容损坏'); }
    files.set(entry.name, text(Buffer.concat(chunks)));
  }
  const skills = [...files].filter(([file]) => /(^|\/)SKILL\.md$/i.test(file));
  if (skills.length !== 1) throw new FeatureConfigError('压缩包必须且只能包含一个 SKILL.md，请分别导入每个 skill');
  return preview(skills[0][1], files, skills[0][0]);
}
