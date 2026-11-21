/*
 * WhatsApp's photos, videos, voice messages, documents and map previews in a
 * chat. They're drawn by MediaAttachment.tsx, which shows Messages' files the
 * same way; this keeps WhatsApp's names for the screens that import them.
 */
export {
  WhatsAppAttachment as default,
  WhatsAppMapPreview,
  Document,
  Sound,
  Viewer,
  VideoViewer,
  keepTabInside,
  useAlive,
  useDialogFocus,
  useOpener,
} from './MediaAttachment';
