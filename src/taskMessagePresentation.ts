/** Hide only the file chip for the very same image already shown in the message. */
export function remainingResultAttachments<T extends { id: string }>(attachments: T[] | undefined, imageUrl: string | undefined): T[] {
  return (attachments ?? []).filter(file => imageUrl !== `/api/attachments/${encodeURIComponent(file.id)}/content`);
}
