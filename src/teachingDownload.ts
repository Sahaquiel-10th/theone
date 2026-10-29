import { authenticatedBlob } from './oneApi';

export async function teachingDownload(url: string, name: string, token?: string) {
  let blob: Blob;
  if (token) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error ?? '附件暂时无法下载'); }
    blob = await response.blob();
  } else blob = await authenticatedBlob(url);
  const objectUrl = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = objectUrl; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
