import { useState, useEffect, type ComponentType } from 'react';
import { Ban, ChartColumn, Eye, MapPin, Phone, PhoneMissed, Star, UserRound, Video } from 'lucide-react';
import { formatDateTime, formatTime } from '../../lib/dates';
import { sidecarCall } from '../../lib/ipc';
import { eventLabel } from '../../lib/messageEvents';
import {
  callLength, callTitle, formatCoordinates, groupReactions, isMissedCall, quoteSender, quoteText, readVcard,
} from '../../lib/whatsapp';
import type { WhatsAppCall, WhatsAppLocation, WhatsAppQuote, WhatsAppReaction } from '../../types/whatsapp';
import Highlight from '../shared/Highlight';

/** An attachment as Messages lists it; WhatsApp's carry the optional extras. */
export interface BubbleAttachment {
  attachment_id: number;
  filename: string;
  mime_type: string;
  transfer_name: string;
  total_bytes?: number | null;
  thumbnail_path?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  /** WhatsApp: whether the file is in the backup. */
  available?: boolean;
}

/**
 * A message as the thread view needs it: Messages' shape, plus what only
 * WhatsApp has. Those extras are drawn only when present, so a Messages or
 * recovered message looks exactly as it always has.
 */
export interface BubbleMessage {
  message_id: number;
  text: string | null;
  message_type: string;
  /** What happened, for a group change, an unsent message or a FaceTime call. */
  event_text?: string | null;
  link_preview?: { url?: string; title?: string; summary?: string; sitename?: string } | null;
  date: string | null;
  is_from_me: boolean;
  sender: string;
  sender_handle?: string;
  has_attachments: boolean;
  is_reaction: boolean;
  attachments?: BubbleAttachment[];
  // WhatsApp only
  quoted?: WhatsAppQuote | null;
  reactions?: WhatsAppReaction[];
  call?: WhatsAppCall | null;
  location?: WhatsAppLocation | null;
  starred?: boolean;
  vcard?: string | null;
}

export interface AttachmentProps {
  udid: string;
  attachment: BubbleAttachment;
  isMine: boolean;
  /** The message's type ("sticker", "document", ...): a hint for how to show the file. */
  messageType: string;
}

export interface MapPreviewProps {
  udid: string;
  location: WhatsAppLocation;
}

interface Props {
  message: BubbleMessage;
  showSender?: boolean;
  udid: string;
  /** Words to mark in the text. */
  query?: string;
  /** The match a search is showing: outlined. */
  current?: boolean;
  /**
   * 'whatsapp' draws WhatsApp's own rows: system notices centred, link
   * previews with their summary, notices without brackets. Messages' look is
   * the default.
   */
  variant?: 'messages' | 'whatsapp';
  /** How attachments are shown. Each source fetches its own files: ids from different databases collide. */
  Attachment?: ComponentType<AttachmentProps>;
  /** The map preview for a shared location (WhatsApp). */
  MapPreview?: ComponentType<MapPreviewProps>;
  /** Clicking a reply's quote goes to the message it quotes. */
  onQuoteClick?: (messageId: number) => void;
  /** The message sits under another day's date pill: show its own date with its time. */
  showDate?: boolean;
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.webp', '.bmp', '.tiff', '.tif'];

function isImageAttachment(a: BubbleAttachment): boolean {
  if (a.mime_type?.startsWith('image/')) return true;
  const name = (a.transfer_name || a.filename || '').toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => name.endsWith(ext));
}

/** Messages' attachments (sms.db ids, get_attachment): photos inline, other files by name. */
function AttachmentItem({ udid, attachment, isMine }: AttachmentProps) {
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
      <div className={`text-xs truncate ${isMine ? 'text-white/75' : 'text-text-tertiary'}`}>
        📎 {attachment.transfer_name || attachment.filename}
      </div>
    );
  }

  if (loading) {
    return <div className={`text-xs italic ${isMine ? 'text-white/75' : 'text-text-tertiary'}`}>Loading…</div>;
  }

  if (error || !data) {
    return (
      <div className={`text-xs italic ${isMine ? 'text-white/75' : 'text-text-tertiary'}`}>
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

/** A reply's quote: who and what, and a way to go to it when it's in this chat. */
function Quote({ quote, isMine, onClick }: { quote: WhatsAppQuote; isMine: boolean; onClick?: (id: number) => void }) {
  const canJump = quote.message_id != null && !!onClick;
  const body = (
    <>
      <span className={`block text-xs font-medium ${isMine ? 'text-white' : 'text-accent'}`}>{quoteSender(quote)}</span>
      <span className={`block text-xs line-clamp-3 whitespace-pre-wrap break-words ${isMine ? 'text-white/85' : 'text-text-secondary'}`}>
        {quoteText(quote)}
      </span>
    </>
  );
  const className = `block w-full text-left mb-1.5 pl-2.5 pr-2 py-1.5 rounded-lg border-l-4 ${
    isMine ? 'border-white/70 bg-white/15' : 'border-accent bg-black/5'
  }`;
  return canJump ? (
    <button
      type="button"
      onClick={() => onClick!(quote.message_id!)}
      title="Show the message this replies to"
      className={`${className} hover:opacity-90`}
    >
      {body}
    </button>
  ) : (
    <div className={className} title={quote.message_id == null ? "The message this replies to isn't in this chat any more" : undefined}>
      {body}
    </div>
  );
}

function CallRow({ call, isMine }: { call: WhatsAppCall; isMine: boolean }) {
  const missed = isMissedCall(call);
  const Glyph = missed ? PhoneMissed : call.is_video ? Video : Phone;
  const length = callLength(call);
  return (
    <div className="flex items-center gap-2.5">
      <span className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
        isMine ? 'bg-white/20' : 'bg-surface'
      }`}>
        <Glyph size={16} className={isMine ? 'text-white' : missed ? 'text-apple-error' : 'text-accent'} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{callTitle(call)}</span>
        {length && <span className={`block text-xs ${isMine ? 'text-white/75' : 'text-text-tertiary'}`}>{length}</span>}
      </span>
    </div>
  );
}

function LocationCard({ udid, location, isMine, MapPreview, label, query }: {
  udid: string;
  location: WhatsAppLocation;
  isMine: boolean;
  MapPreview?: ComponentType<MapPreviewProps>;
  label: string;
  query: string;
}) {
  const coords = formatCoordinates(location.latitude, location.longitude);
  return (
    <div className="flex flex-col gap-1.5">
      {MapPreview && location.thumbnail_path && location.attachment_id != null && (
        <MapPreview udid={udid} location={location} />
      )}
      <div className="flex items-start gap-2">
        <MapPin size={16} className={`mt-0.5 flex-shrink-0 ${isMine ? 'text-white' : 'text-accent'}`} />
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            <Highlight text={location.place_name || label} query={query} markClassName={isMine ? 'text-text-primary' : 'text-inherit'} />
          </span>
          {coords && <span className={`block text-xs tabular-nums ${isMine ? 'text-white/75' : 'text-text-tertiary'}`}>{coords}</span>}
        </span>
      </div>
    </div>
  );
}

function ContactCard({ vcard, text, isMine }: { vcard: string | null | undefined; text: string | null; isMine: boolean }) {
  const card = readVcard(vcard);
  const name = card.name || text || 'Contact card';
  return (
    <div className="flex items-center gap-2.5">
      <span className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isMine ? 'bg-white/20' : 'bg-surface'}`}>
        <UserRound size={16} className={isMine ? 'text-white' : 'text-text-secondary'} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium break-words">{name}</span>
        {card.phones.map(p => (
          <span key={p} className={`block text-xs ${isMine ? 'text-white/75' : 'text-text-tertiary'}`}>{p}</span>
        ))}
      </span>
    </div>
  );
}

/** A deleted message, a poll, a view-once photo: a short line in the bubble saying what it was. */
function Notice({ icon: Glyph, text, isMine, query = '' }: { icon: typeof Ban; text: string; isMine: boolean; query?: string }) {
  return (
    <p className={`flex items-center gap-1.5 text-sm italic ${isMine ? 'text-white/85' : 'text-text-secondary'}`}>
      <Glyph size={15} className="flex-shrink-0" />
      <span><Highlight text={text} query={query} markClassName={isMine ? 'text-text-primary' : 'text-inherit'} /></span>
    </p>
  );
}

function Reactions({ reactions, isMine }: { reactions: WhatsAppReaction[]; isMine: boolean }) {
  const groups = groupReactions(reactions);
  if (groups.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 -mt-1.5 px-2 relative ${isMine ? 'justify-end' : 'justify-start'}`}>
      {groups.map(g => (
        <span
          key={g.emoji}
          title={g.names.join(', ')}
          className={`inline-flex items-center gap-1 text-sm leading-none px-2 py-1 rounded-full border shadow-sm bg-surface ${
            g.mine ? 'border-accent' : 'border-rule'
          }`}
        >
          {/* A plain span can't carry a label screen readers announce, so the words are text they read */}
          <span className="sr-only">{`${g.emoji} from ${g.names.join(', ')}`}</span>
          <span aria-hidden="true">{g.emoji}</span>
          {g.names.length > 1 && <span className="text-xs text-text-secondary tabular-nums" aria-hidden="true">{g.names.length}</span>}
        </span>
      ))}
    </div>
  );
}

export default function ChatBubble({
  message, showSender, udid, query = '', current = false, variant = 'messages',
  Attachment = AttachmentItem, MapPreview, onQuoteClick, showDate = false,
}: Props) {
  if (message.is_reaction) return null;

  const isMine = message.is_from_me;
  const wa = variant === 'whatsapp';
  const time = showDate ? formatDateTime(message.date) : formatTime(message.date);

  // WhatsApp's own notices ("Messages and calls are end-to-end encrypted", "You were added")
  // belong to the chat, not to anyone in it: centred, without a bubble.
  if (wa && message.message_type === 'system') {
    return (
      <div data-message-id={message.message_id} className="flex justify-center w-full my-2">
        <div className={`max-w-[80%] text-center text-xs text-text-secondary bg-sand rounded-lg px-3 py-1.5 ${
          current ? 'outline outline-4 outline-amber-300 outline-offset-2' : ''
        }`}>
          <Highlight text={eventLabel(message)} query={query} />
          {time && <span className="text-text-tertiary"> · {time}</span>}
        </div>
      </div>
    );
  }

  const muted = isMine ? 'text-white/75' : 'text-text-tertiary';
  const type = message.message_type;
  const attachments = message.has_attachments && message.attachments ? message.attachments : [];
  // Rows WhatsApp draws as something other than text
  const contact = wa && (type === 'contact' || !!message.vcard);
  const special = !!message.call || !!message.location || contact || (wa && ['deleted', 'poll', 'view_once'].includes(type));
  // A sticker on its own is drawn without a bubble around it, as WhatsApp does
  const bare = wa && type === 'sticker' && !message.text && attachments.length > 0;
  // Messages puts the text above its files; WhatsApp shows a photo with its caption under it
  const text = message.text && !contact && !(wa && type === 'deleted') ? (
    <p className={`text-sm whitespace-pre-wrap break-words ${wa && type === 'poll' ? 'mt-1 font-medium' : ''} ${wa && attachments.length > 0 ? 'mt-1.5' : ''}`}>
      <Highlight text={message.text} query={query} markClassName={isMine ? 'text-text-primary' : 'text-inherit'} />
    </p>
  ) : null;
  const files = attachments.length > 0 ? (
    <div className={bare || (wa && !message.quoted) ? '' : 'mt-1 space-y-1'}>
      {attachments.map((a) => (
        <Attachment key={a.attachment_id} udid={udid} attachment={a} isMine={isMine} messageType={type} />
      ))}
    </div>
  ) : null;
  const preview = message.link_preview;
  const showPreview = wa ? !!(preview && (preview.url || preview.title || preview.summary)) : !!preview?.url;

  return (
    <div data-message-id={message.message_id} className={`flex w-full ${isMine ? 'justify-end' : 'justify-start'} mb-1`}>
      <div className={`max-w-[70%] ${isMine ? 'items-end' : 'items-start'}`}>
        {showSender && !isMine && message.sender && (
          <div className="text-xs text-text-tertiary mb-0.5 px-3">{message.sender}</div>
        )}
        <div
          className={`${bare ? '' : 'px-4 py-2.5'} ${
            isMine && !bare
              ? 'text-white'
              : 'text-text-primary'
          } ${current ? 'outline outline-4 outline-amber-300 outline-offset-2' : ''}`}
          style={bare ? { borderRadius: 12 } : {
            background: isMine ? 'var(--bubble-me)' : 'var(--bubble-them)',
            borderRadius: 20,
            borderBottomRightRadius: isMine ? 6 : 20,
            borderBottomLeftRadius: isMine ? 20 : 6,
            boxShadow: isMine
              ? '0 4px 14px rgba(217,119,87,.2)'
              : '0 1px 0 rgba(30,26,22,.04)',
          }}
        >
          {message.quoted && <Quote quote={message.quoted} isMine={isMine} onClick={onQuoteClick} />}
          {message.call && <CallRow call={message.call} isMine={isMine} />}
          {message.location && (
            <LocationCard
              udid={udid}
              location={message.location}
              isMine={isMine}
              MapPreview={MapPreview}
              label={type === 'live_location' ? 'Live location' : 'Location'}
              query={query}
            />
          )}
          {contact && <ContactCard vcard={message.vcard} text={message.text} isMine={isMine} />}
          {wa && type === 'deleted' && <Notice icon={Ban} text={eventLabel(message)} isMine={isMine} />}
          {wa && type === 'view_once' && <Notice icon={Eye} text={eventLabel(message)} isMine={isMine} />}
          {wa && type === 'poll' && <Notice icon={ChartColumn} text={eventLabel(message)} isMine={isMine} query={query} />}
          {!wa && text}
          {wa && files}
          {wa && text}
          {showPreview && preview && (
            <div className={`mt-1.5 text-xs ${isMine ? 'text-white/75' : 'text-gray-500'}`}>
              {preview.title && (
                <div className="font-medium">{preview.title}</div>
              )}
              {wa && preview.summary && <div className="line-clamp-3">{preview.summary}</div>}
              {preview.url && <div className="truncate">{preview.url}</div>}
            </div>
          )}
          {!wa && files}
          {!message.text && !message.has_attachments && !special && (
            wa ? (
              <p className={`text-sm italic ${isMine ? 'text-white/85' : 'text-text-secondary'}`}>{eventLabel(message)}</p>
            ) : (
              <p className={`text-xs italic ${muted}`}>
                [{eventLabel(message)}]
              </p>
            )
          )}
        </div>
        {message.reactions && message.reactions.length > 0 && <Reactions reactions={message.reactions} isMine={isMine} />}
        <div className={`text-xs text-text-tertiary mt-0.5 px-3 flex items-center gap-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
          {message.starred && <Star size={12} className="text-amber-500 fill-amber-400" aria-label="Starred" />}
          {time}
        </div>
      </div>
    </div>
  );
}
