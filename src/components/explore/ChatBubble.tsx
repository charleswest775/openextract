import { useState, useEffect } from 'react';
import { formatTime } from '../../lib/dates';
import { sidecarCall } from '../../lib/ipc';

interface Attachment {
  attachment_id: number;
  filename: string;
  mime_type: string;
  transfer_name: string;
  total_bytes: number;
}

interface Message {
  message_id: number;
  text: string | null;
  message_type: string;
  link_preview?: { url?: string; title?: string; summary?: string; sitename?: string };
  date: string;
  is_from_me: boolean;
  sender: string;
  sender_handle: string;
  has_attachments: boolean;
  is_reaction: boolean;
  attachments?: Attachment[];
}

interface Props {
  message: Message;
  showSender?: boolean;
  udid: string;
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.webp', '.bmp', '.tiff', '.tif'];

function isImageAttachment(a: Attachment): boolean {
  if (a.mime_type?.startsWith('image/')) return true;
  const name = (a.transfer_name || a.filename || '').toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => name.endsWith(ext));
}

function AttachmentItem({ udid, attachment, isMine }: { udid: string; attachment: Attachment; isMine: boolean }) {
  const [data, setData] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isImageAttachment(attachment)) return;
    setLoading(true);
    sidecarCall<{ data: string; mime_type: string; filename: string }>(
      'get_attachment',
      { udid, attachment_id: attachment.attachment_id }
    ).then((result) => {
      setData(`data:${result.mime_type};base64,${result.data}`);
    }).catch(() => {
      setError(true);
    }).finally(() => {
      setLoading(false);
    });
  }, [udid, attachment]);

  if (!isImageAttachment(attachment)) {
    return (
      <div className={`text-xs truncate ${isMine ? 'text-white/75' : 'text-gray-400'}`}>
        📎 {attachment.transfer_name || attachment.filename}
      </div>
    );
  }

  if (loading) {
    return <div className={`text-xs italic ${isMine ? 'text-white/75' : 'text-gray-400'}`}>Loading…</div>;
  }

  if (error || !data) {
    return (
      <div className={`text-xs italic ${isMine ? 'text-white/75' : 'text-gray-400'}`}>
        {attachment.transfer_name || attachment.filename}
      </div>
    );
  }

  return (
    <img
      src={data}
      alt={attachment.transfer_name || 'Attachment'}
      className="rounded-lg max-h-64 max-w-full object-contain mt-1"
      onError={() => setError(true)}
    />
  );
}

export default function ChatBubble({ message, showSender, udid }: Props) {
  if (message.is_reaction) return null;

  const isMine = message.is_from_me;

  return (
    <div className={`flex w-full ${isMine ? 'justify-end' : 'justify-start'} mb-1`}>
      <div className={`max-w-[70%] ${isMine ? 'items-end' : 'items-start'}`}>
        {showSender && !isMine && message.sender && (
          <div className="text-[11px] text-gray-400 mb-0.5 px-3">{message.sender}</div>
        )}
        <div
          className={`px-4 py-2.5 ${
            isMine
              ? 'text-white'
              : 'text-text-primary'
          }`}
          style={{
            background: isMine ? 'var(--bubble-me)' : 'var(--bubble-them)',
            borderRadius: 20,
            borderBottomRightRadius: isMine ? 6 : 20,
            borderBottomLeftRadius: isMine ? 20 : 6,
            boxShadow: isMine
              ? '0 4px 14px rgba(217,119,87,.2)'
              : '0 1px 0 rgba(30,26,22,.04)',
          }}
        >
          {message.text && (
            <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
          )}
          {message.link_preview?.url && (
            <div className={`mt-1.5 text-xs ${isMine ? 'text-white/75' : 'text-gray-500'}`}>
              {message.link_preview.title && (
                <div className="font-medium">{message.link_preview.title}</div>
              )}
              <div className="truncate">{message.link_preview.url}</div>
            </div>
          )}
          {message.has_attachments && message.attachments && message.attachments.length > 0 && (
            <div className="mt-1 space-y-1">
              {message.attachments.map((a) => (
                <AttachmentItem key={a.attachment_id} udid={udid} attachment={a} isMine={isMine} />
              ))}
            </div>
          )}
          {!message.text && !message.has_attachments && (
            <p className={`text-xs italic ${isMine ? 'text-white/75' : 'text-gray-400'}`}>
              [{message.message_type}]
            </p>
          )}
        </div>
        <div className={`text-[10px] text-gray-400 mt-0.5 px-3 ${isMine ? 'text-right' : 'text-left'}`}>
          {formatTime(message.date)}
        </div>
      </div>
    </div>
  );
}
