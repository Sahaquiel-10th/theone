import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { imaFileFormat, imaFileMaxBytes, parseImaFile, readImaFile } from "./imaFileReader.js";

const input = () => ({ url: "https://pkb.ima.myqcloud.com/official-file", headers: {}, mediaType: 13, title: "资料.txt", query: "杭州", signal: AbortSignal.timeout(20_000) });
test("ima original-file reader rejects unreviewed destinations, credentials in URLs and unsafe forwarded headers before networking", async () => {
  let calls = 0; const fetcher = (async () => { calls++; return new Response("never"); }) as typeof fetch;
  for (const url of ["http://pkb.ima.myqcloud.com/a", "https://pkb.ima.myqcloud.com.evil.test/a", "https://127.0.0.1/a", "https://user:secret@pkb.ima.myqcloud.com/a", "https://pkb.ima.myqcloud.com:444/a", "https://ima.qq.com/a"]) await assert.rejects(readImaFile({ ...input(), url }, fetcher));
  for (const headers of [{ Cookie: "private" }, { Host: "127.0.0.1" }, { Authorization: "a\r\nb" }]) await assert.rejects(readImaFile({ ...input(), headers }, fetcher));
  assert.equal(calls, 0); assert.equal(imaFileFormat(3, "old.doc"), undefined);
});
test("ima original-file reader bounds advertised and streamed bytes and refuses redirects", async () => {
  for (const response of [new Response("large", { headers: { "content-length": String(imaFileMaxBytes + 1) } }), new Response(new Uint8Array(imaFileMaxBytes + 1)), new Response("redirect", { status: 302, headers: { location: "http://127.0.0.1/private" } })]) {
    await assert.rejects(readImaFile(input(), (async (_url, init) => { assert.equal(init?.redirect, "error"); assert.equal(init?.method, "GET"); assert.deepEqual([...new Headers(init?.headers).keys()], []); return response; }) as typeof fetch));
  }
});
test("ima text parsing runs in a separate restricted process and returns bounded real excerpts", async () => {
  const text = await parseImaFile(Buffer.from("杭州位于钱塘江下游。\n".repeat(5000)), "txt", "钱塘江", AbortSignal.timeout(20_000));
  assert.ok(text.includes("钱塘江")); assert.ok(text.length <= 24_000);
  await assert.rejects(parseImaFile(Buffer.from("not a PDF"), "pdf", "杭州", AbortSignal.timeout(20_000)));
  await assert.rejects(parseImaFile(Buffer.from("test"), "txt", "杭州", AbortSignal.abort()));
});
test("ima reader parses a real DOCX buffer without retaining files or calling a model", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>杭州位于钱塘江下游。</w:t></w:r></w:p></w:body></w:document>');
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const result = await readImaFile({ ...input(), title: "资料.docx", mediaType: 3 }, (async () => new Response(new Uint8Array(bytes))) as typeof fetch);
  assert.match(result, /杭州位于钱塘江下游/);
});

test("ima reader extracts real PDF text with dynamic code generation disabled", async () => {
  const stream = "BT /F1 12 Tf 30 120 Td (Hangzhou Qiantang River) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const result = await parseImaFile(Buffer.from(pdf), "pdf", "Hangzhou", AbortSignal.timeout(20_000));
  assert.match(result, /Hangzhou Qiantang River/);
});
