// Only a bounded document buffer and query arrive over IPC. This process gets
// neither provider credentials nor a source URL, and never writes document data.
function excerpts(text, query) {
  text = text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > 2_000_000) throw Error("text bounds");
  const tokens = [...new Set((query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || []).flatMap(t => t.length <= 4 ? [t] : [t, ...Array.from({ length: Math.min(t.length - 1, 30) }, (_, i) => t.slice(i, i + 2))]))].slice(0, 50);
  const parts = [];
  for (let offset = 0; offset < text.length; offset += 3200) { const body = text.slice(offset, offset + 3500), lower = body.toLowerCase(); parts.push({ offset, body, score: tokens.reduce((n, t) => n + (lower.includes(t) ? t.length : 0), 0) }); }
  return parts.sort((a, b) => b.score - a.score || a.offset - b.offset).slice(0, 6).sort((a, b) => a.offset - b.offset).map(p => p.body).join("\n\n[…原文节选…]\n\n").slice(0, 24_000);
}
process.once("message", async input => {
  try {
    if (!input || !Buffer.isBuffer(input.bytes) || input.bytes.length > 12 * 1024 * 1024 || typeof input.query !== "string" || input.query.length > 400) throw Error("input");
    const buffer = input.bytes; let text;
    if (input.format === "pdf") {
      if (buffer.subarray(0, 5).toString() !== "%PDF-") throw Error("signature");
      // The old PDF.js compatibility shim otherwise uses Function() merely to
      // locate the global object. Supply it directly; generated code stays off.
      globalThis.self = globalThis;
      const parse = require("pdf-parse/lib/pdf-parse.js");
      text = (await parse(new Uint8Array(buffer), { max: 100 })).text;
    } else if (input.format === "docx") {
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw Error("signature");
      const zip = await require("jszip").loadAsync(buffer), entries = Object.values(zip.files);
      if (entries.length > 2000 || entries.reduce((n, e) => n + Number(e._data?.uncompressedSize || 0), 0) > 64 * 1024 * 1024) throw Error("archive bounds");
      text = (await require("mammoth").extractRawText({ buffer })).value;
    } else if (input.format === "txt") text = buffer.toString("utf8");
    else throw Error("format");
    process.send?.({ text: excerpts(text, input.query) });
  } catch { process.send?.({ unavailable: true }); }
  process.disconnect?.();
});
