import { Message } from '../hooks/useMessages';
import { formatTime, formatDateTime } from '../lib/dates';
import { useState } from 'react';
import AttachmentViewer from './AttachmentViewer';

declare const window: Window & { openextract?: { openExternal?: (url: string) => void } };

interface Props {
  message: Message;
  udid: string;
}

const SYSTEM_MESSAGE_LABELS: Record<string, (sender: string) => string> = {
  location:                 ()       => '📍 Location shared',
  location_started_by_me:   (sender) => `📍 You started sharing your location with ${sender}.`,
  location_stopped_by_me:   (sender) => `📍 You stopped sharing your location with ${sender}.`,
  location_started_by_them: (sender) => `📍 ${sender} started sharing their location with you.`,
  location_stopped_by_them: (sender) => `📍 ${sender} stopped sharing their location with you.`,
  payment:                  ()       => '💳 Apple Pay',
  audio:                    ()       => '🎵 Audio message',
  fitness:                  ()       => '🏃 Activity shared',
  game:                     ()       => '🎮 Game Center',
  digital_touch:            ()       => '✨ Digital Touch',
  handwriting:              ()       => '✍️ Handwriting',
  app:                      ()       => '📲 App interaction',
  system:                   ()       => 'ℹ️ System message',
};

function SystemMessageBanner({ message }: { message: Message }) {
  const [showTimestamp, setShowTimestamp] = useState(false);
  const labelFn = SYSTEM_MESSAGE_LABELS[message.message_type];
  const label = labelFn ? labelFn(message.sender) : 'ℹ️ System message';
  return (
    <div className="flex flex-col items-center my-2" onClick={() => setShowTimestamp(t => !t)}>
      <span className="text-xs text-gray-400 italic cursor-pointer select-none">{label}</span>
      {showTimestamp && (
        <span className="text-[10px] text-gray-400 mt-0.5">{formatDateTime(message.date)}</span>
      )}
    </div>
  );
}

function LinkPreviewBubble({ message }: { message: Message }) {
  const [showTimestamp, setShowTimestamp] = useState(false);
  const isFromMe = message.is_from_me;
  const lp = message.link_preview;
  const url = lp?.url ?? '';

  const handleClick = () => {
    if (url && window.openextract?.openExternal) {
      window.openextract.openExternal(url);
    }
  };

  return (
    <div className={`flex flex-col ${isFromMe ? 'items-end' : 'items-start'} mb-1`}>
      {!isFromMe && message.sender && (
        <span className="text-xs text-gray-500 ml-3 mb-0.5">{message.sender}</span>
      )}
      <div
        onClick={() => setShowTimestamp(t => !t)}
        className={`max-w-[75%] rounded-2xl overflow-hidden cursor-pointer border ${
          isFromMe ? 'border-blue-400 bg-imessage-blue text-white rounded-br-md' : 'border-gray-200 bg-bubble-gray text-gray-900 rounded-bl-md'
        }`}
      >
        {/* Link card */}
        <div
          className={`px-3 py-2 ${isFromMe ? 'border-t border-blue-400' : 'border-t border-gray-200'}`}
          onClick={(e) => { e.stopPropagation(); handleClick(); }}
        >
          {lp?.sitename && (
            <p className={`text-[10px] uppercase tracking-wide mb-0.5 ${isFromMe ? 'text-blue-200' : 'text-gray-400'}`}>
              {lp.sitename}
            </p>
          )}
          {lp?.title && (
            <p className="text-sm font-semibold leading-snug">{lp.title}</p>
          )}
          {lp?.summary && (
            <p className={`text-xs mt-0.5 line-clamp-2 ${isFromMe ? 'text-blue-100' : 'text-gray-500'}`}>
              {lp.summary}
            </p>
          )}
          {url && (
            <p className={`text-[10px] mt-1 truncate ${isFromMe ? 'text-blue-200' : 'text-blue-500'}`}>
              {url}
            </p>
          )}
        </div>
      </div>
      {showTimestamp && (
        <span className="text-[10px] text-gray-400 mt-0.5 mx-3">{formatDateTime(message.date)}</span>
      )}
    </div>
  );
}

export default function ChatBubble({ message, udid }: Props) {
  const [showTimestamp, setShowTimestamp] = useState(false);

  // Skip reaction messages in the main flow
  if (message.is_reaction) return null;

  // Render link previews as positioned bubbles
  if (message.message_type === 'link') {
    return <LinkPreviewBubble message={message} />;
  }

  // Render system/service messages as a centred banner
  if (message.message_type && message.message_type in SYSTEM_MESSAGE_LABELS) {
    return <SystemMessageBanner message={message} />;
  }

  const isFromMe = message.is_from_me;
  const hasText = message.text && message.text.trim().length > 0;

  return (
    <div className={`flex flex-col ${isFromMe ? 'items-end' : 'items-start'} mb-1`}>
      {/* Sender name for received messages */}
      {!isFromMe && message.sender !== 'Unknown' && (
        <span className="text-xs text-gray-500 ml-3 mb-0.5">
          {message.sender}
        </span>
      )}

      <div
        onClick={() => setShowTimestamp(!showTimestamp)}
        className={`max-w-[75%] px-3 py-2 rounded-2xl cursor-pointer select-text ${isFromMe
            ? 'bg-imessage-blue text-white rounded-br-md'
            : 'bg-bubble-gray text-gray-900 rounded-bl-md'
          }`}
      >
        {hasText && (
          <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
        )}

        {message.has_attachments && message.attachments && (
          <div className={`flex flex-col space-y-2 ${hasText ? 'mt-2' : ''}`}>
            {message.attachments.map((attachment) => (
              <AttachmentViewer key={attachment.attachment_id} udid={udid} attachment={attachment} />
            ))}
          </div>
        )}

        {!hasText && !message.has_attachments && (
          <p className="text-sm italic opacity-50 select-none">···</p>
        )}
      </div>

      {/* Timestamp (shown on click) */}
      {showTimestamp && (
        <span className="text-[10px] text-gray-400 mt-0.5 mx-3">
          {formatDateTime(message.date)}
        </span>
      )}
    </div>
  );
}
