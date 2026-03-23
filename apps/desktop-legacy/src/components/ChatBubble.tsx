import { Message } from '../hooks/useMessages';
import { formatTime, formatDateTime } from '../lib/dates';
import { useState } from 'react';
import { MapPin, CreditCard, Music, Activity, Gamepad2, Sparkles, PenTool, Smartphone, Info } from 'lucide-react';
import AttachmentViewer from './AttachmentViewer';

declare const window: Window & { openextract?: { openExternal?: (url: string) => void } };

interface Props {
  message: Message;
  udid: string;
}

const SYSTEM_MESSAGE_ICONS: Record<string, { icon: typeof MapPin; label: (sender: string) => string }> = {
  location:                 { icon: MapPin,     label: ()       => 'Location shared' },
  location_started_by_me:   { icon: MapPin,     label: (sender) => `You started sharing your location with ${sender}.` },
  location_stopped_by_me:   { icon: MapPin,     label: (sender) => `You stopped sharing your location with ${sender}.` },
  location_started_by_them: { icon: MapPin,     label: (sender) => `${sender} started sharing their location with you.` },
  location_stopped_by_them: { icon: MapPin,     label: (sender) => `${sender} stopped sharing their location with you.` },
  payment:                  { icon: CreditCard, label: ()       => 'Apple Pay' },
  audio:                    { icon: Music,      label: ()       => 'Audio message' },
  fitness:                  { icon: Activity,   label: ()       => 'Activity shared' },
  game:                     { icon: Gamepad2,   label: ()       => 'Game Center' },
  digital_touch:            { icon: Sparkles,   label: ()       => 'Digital Touch' },
  handwriting:              { icon: PenTool,    label: ()       => 'Handwriting' },
  app:                      { icon: Smartphone, label: ()       => 'App interaction' },
  system:                   { icon: Info,       label: ()       => 'System message' },
};

function SystemMessageBanner({ message }: { message: Message }) {
  const [showTimestamp, setShowTimestamp] = useState(false);
  const entry = SYSTEM_MESSAGE_ICONS[message.message_type];
  const Icon = entry?.icon ?? Info;
  const label = entry ? entry.label(message.sender) : 'System message';
  return (
    <div className="flex flex-col items-center my-2" onClick={() => setShowTimestamp(t => !t)}>
      <span className="inline-flex items-center gap-1.5 text-caption text-text-tertiary italic cursor-pointer select-none">
        <Icon size={12} strokeWidth={1.5} />
        {label}
      </span>
      {showTimestamp && (
        <span className="text-[10px] text-text-tertiary mt-0.5">{formatDateTime(message.date)}</span>
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
        <span className="text-caption text-text-secondary ml-3 mb-0.5">{message.sender}</span>
      )}
      <div
        onClick={() => setShowTimestamp(t => !t)}
        className={`max-w-[75%] rounded-2xl overflow-hidden cursor-pointer ${
          isFromMe ? 'bg-imessage-blue text-white rounded-br-md' : 'bg-elevated text-text-primary rounded-bl-md'
        }`}
        style={{ border: isFromMe ? '1px solid #007AFF' : '0.5px solid var(--border-default)' }}
      >
        <div
          className="px-3 py-2"
          style={{ borderTop: isFromMe ? '1px solid rgba(255,255,255,0.2)' : '0.5px solid var(--border-default)' }}
          onClick={(e) => { e.stopPropagation(); handleClick(); }}
        >
          {lp?.sitename && (
            <p className={`text-[10px] uppercase tracking-wide mb-0.5 ${isFromMe ? 'text-blue-200' : 'text-text-tertiary'}`}>
              {lp.sitename}
            </p>
          )}
          {lp?.title && (
            <p className="text-body font-semibold leading-snug">{lp.title}</p>
          )}
          {lp?.summary && (
            <p className={`text-caption mt-0.5 line-clamp-2 ${isFromMe ? 'text-blue-100' : 'text-text-secondary'}`}>
              {lp.summary}
            </p>
          )}
          {url && (
            <p className={`text-[10px] mt-1 truncate ${isFromMe ? 'text-blue-200' : 'text-text-accent'}`}>
              {url}
            </p>
          )}
        </div>
      </div>
      {showTimestamp && (
        <span className="text-[10px] text-text-tertiary mt-0.5 mx-3">{formatDateTime(message.date)}</span>
      )}
    </div>
  );
}

export default function ChatBubble({ message, udid }: Props) {
  const [showTimestamp, setShowTimestamp] = useState(false);

  if (message.is_reaction) return null;

  if (message.message_type === 'link') {
    return <LinkPreviewBubble message={message} />;
  }

  if (message.message_type && message.message_type in SYSTEM_MESSAGE_ICONS) {
    return <SystemMessageBanner message={message} />;
  }

  const isFromMe = message.is_from_me;
  const hasText = message.text && message.text.trim().length > 0;

  return (
    <div className={`flex flex-col ${isFromMe ? 'items-end' : 'items-start'} mb-1`}>
      {!isFromMe && message.sender !== 'Unknown' && (
        <span className="text-caption text-text-secondary ml-3 mb-0.5">
          {message.sender}
        </span>
      )}

      <div
        onClick={() => setShowTimestamp(!showTimestamp)}
        className={`max-w-[75%] px-3 py-2 rounded-2xl cursor-pointer select-text ${isFromMe
            ? 'bg-imessage-blue text-white rounded-br-md'
            : 'bg-elevated text-text-primary rounded-bl-md'
          }`}
      >
        {hasText && (
          <p className="text-body whitespace-pre-wrap break-words">{message.text}</p>
        )}

        {message.has_attachments && message.attachments && (
          <div className={`flex flex-col space-y-2 ${hasText ? 'mt-2' : ''}`}>
            {message.attachments.map((attachment) => (
              <AttachmentViewer key={attachment.attachment_id} udid={udid} attachment={attachment} />
            ))}
          </div>
        )}

        {!hasText && !message.has_attachments && (
          <p className="text-body italic opacity-50 select-none">&middot;&middot;&middot;</p>
        )}
      </div>

      {showTimestamp && (
        <span className="text-[10px] text-text-tertiary mt-0.5 mx-3">
          {formatDateTime(message.date)}
        </span>
      )}
    </div>
  );
}
