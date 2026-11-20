import { attachmentKind, documentName, kindLabel, type AttachmentKind } from './whatsapp';

type Attachment = { mime_type?: string | null; transfer_name?: string | null; filename?: string | null };

const MANY: Record<AttachmentKind, string> = {
  image: 'photos', sticker: 'stickers', gif: 'GIFs', video: 'videos', voice: 'voice messages', audio: 'audio files', document: 'documents',
};

/**
 * One line for what a message sent, when it was only files: "Photo",
 * "3 photos", "Video", "Voice message", "Quarterly report.pdf", or
 * "2 attachments" for a mix. Empty when there are no files.
 */
export function attachmentSummary(attachments: Attachment[] | null | undefined, messageType?: string | null): string {
  const files = attachments ?? [];
  if (files.length === 0) return '';
  const kinds = files.map(a => attachmentKind({
    mime_type: a.mime_type ?? null, transfer_name: a.transfer_name ?? '', filename: a.filename ?? '',
  }, messageType === 'audio' ? 'audio' : null));
  // An iMessage audio message is a voice message, whatever its file says
  const fixed = messageType === 'audio' ? kinds.map(k => (k === 'audio' ? 'voice' : k)) : kinds;
  const first = fixed[0];
  if (fixed.every(k => k === first)) {
    if (files.length === 1) {
      if (first === 'document') return documentName({ transfer_name: files[0].transfer_name ?? '', filename: files[0].filename ?? '' }) || kindLabel(first);
      return kindLabel(first);
    }
    return `${files.length} ${MANY[first]}`;
  }
  return `${files.length} attachments`;
}
