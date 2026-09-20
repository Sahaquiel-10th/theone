import fs from "node:fs/promises";
import { parseAttachment } from "./attachmentParser.js";

// Only launched by AttachmentService with a server-generated storage path.
const [storagePath, originalName, mimeType] = process.argv.slice(2);
try {
  const parsed = await parseAttachment(await fs.readFile(storagePath), originalName, mimeType);
  const text = parsed.extractedText;
  let segmentCount = 0;
  const output = await fs.open(`${storagePath}.segments.tmp`, "w", 0o600);
  try {
    for (let offset = 0; offset < text.length; offset += 4000) {
      await output.write(`${JSON.stringify({ index: segmentCount++, text: text.slice(offset, offset + 4000) })}\n`);
    }
  } finally { await output.close(); }
  await fs.rename(`${storagePath}.segments.tmp`, `${storagePath}.segments`);
  process.send?.({ ok: true, kind: parsed.kind, mimeType: parsed.mimeType, textChars: text.length, segmentCount });
} catch (error) {
  // Parser/library errors can contain document text: return only curated errors.
  const message = error instanceof Error ? error.message : "";
  const safe = /^(文件内容与扩展名不一致|没有从文件中读取到可分析的文字|Office 文件|文件文字超过安全解析上限|暂不支持这个文件格式)/.test(message);
  process.send?.({ ok: false, error: safe ? message : "无法解析这个文件，请检查格式或导出为 PDF、DOCX、XLSX 后重试" });
}
