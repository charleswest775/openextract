import { formatTime } from '../../lib/dates';

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
  attachments?: { attachment_id: number; filename: string; mime_type: string; transfer_name: string; total_bytes: number }[];
}

interface Props {
  message: Message;
  showSender?: boolean;
}

export default function ChatBubble({ message, showSender }: Props) {
  if (message.is_reaction) return null;

  const isMine = message.is_from_me;

  return (
    <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} mb-1`}>
      <div className={`max-w-[70%] ${isMine ? 'items-end' : 'items-start'}`}>
        {showSender && !isMine && message.sender && (
          <div className="text-[11px] text-gray-400 mb-0.5 px-3">{message.sender}</div>
        )}
        <div
          className={`rounded-2xl px-3.5 py-2 ${
            isMine
              ? 'bg-emerald-500 text-white'
              : 'bg-gray-100 text-gray-900'
          }`}
        >
          {message.text && (
            <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
          )}
          {message.link_preview?.url && (
            <div className={`mt-1.5 text-xs ${isMine ? 'text-emerald-100' : 'text-gray-500'}`}>
              {message.link_preview.title && (
                <div className="font-medium">{message.link_preview.title}</div>
              )}
              <div className="truncate">{message.link_preview.url}</div>
            </div>
          )}
          {message.has_attachments && message.attachments && message.attachments.length > 0 && (
            <div className={`mt-1 text-xs ${isMine ? 'text-emerald-100' : 'text-gray-400'}`}>
              {message.attachments.map((a) => (
                <div key={a.attachment_id} className="truncate">
                  {a.transfer_name || a.filename}
                </div>
              ))}
            </div>
          )}
          {!message.text && !message.has_attachments && (
            <p className={`text-xs italic ${isMine ? 'text-emerald-100' : 'text-gray-400'}`}>
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
