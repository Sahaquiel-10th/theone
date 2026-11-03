/** Official copy-all text only; never execute a pasted command or save it outside the form. */
export function parseImaCredentials(text: string) {
  if (text.length > 16_384) return undefined;
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 2) return undefined;
  const client = lines.find(line => /^Client\s*ID\s*[:：]/i.test(line))?.match(/^Client\s*ID\s*[:：]\s*([^\s]+)$/i)?.[1];
  const key = lines.find(line => /^API\s*Key\s*[:：]/i.test(line))?.match(/^API\s*Key\s*[:：]\s*([^\s]+)$/i)?.[1];
  return client && key && key.length >= 8 && client.length <= 2000 && key.length <= 8192 ? { clientId: client, apiKey: key } : undefined;
}
