import { attachmentKind, documentName, kindLabel, nothingKnown, UNKNOWN_FILE, type AttachmentKind } from './whatsapp';

type Attachment = { mime_type?: string | null; transfer_name?: string | null; filename?: string | null };

const asFile = (a: Attachment) => ({ mime_type: a.mime_type ?? null, transfer_name: a.transfer_name ?? '', filename: a.filename ?? '' });

const MANY: Record<AttachmentKind, string> = {
  image: 'photos', sticker: 'stickers', gif: 'GIFs', video: 'videos', voice: 'voice messages', audio: 'audio files', document: 'documents',
};

/**
 * One line for what a message sent, when it was only files: "Photo",
 * "3 photos", "Video", "Voice message", "Quarterly report.pdf", or
 * "2 attachments" for a mix. "Attachment" for a file nothing is known about
 * (a photo or file whose record iOS removed). Empty when there are no files.
 */
export function attachmentSummary(attachments: Attachment[] | null | undefined, messageType?: string | null): string {
  const files = attachments ?? [];
  if (files.length === 0) return '';
  // A file nothing is known about isn't counted as any kind
  if (files.some(a => nothingKnown(asFile(a)))) {
    return files.length === 1 ? UNKNOWN_FILE : `${files.length} attachments`;
  }
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

/**
 * Each file named with what it is, for a saved text: ["Photo: IMG_4127.HEIC",
 * "Video: trail-cam.mp4"]. A file with no name of its own is just its kind ("Photo"),
 * and one nothing is known about is an "Attachment not in this backup".
 */
export function attachmentLabels(attachments: Attachment[] | null | undefined, messageType?: string | null): string[] {
  return (attachments ?? []).map(a => {
    // Nothing known about it: iOS removed its record, and the file with it
    if (nothingKnown(asFile(a))) return `${UNKNOWN_FILE} not in this backup`;
    let kind = attachmentKind({ mime_type: a.mime_type ?? null, transfer_name: a.transfer_name ?? '', filename: a.filename ?? '' }, messageType === 'audio' ? 'audio' : null);
    if (messageType === 'audio' && kind === 'audio') kind = 'voice';
    const name = documentName({ transfer_name: a.transfer_name ?? '', filename: a.filename ?? '' });
    return name ? `${kindLabel(kind)}: ${name}` : kindLabel(kind);
  });
}
