import { memo, useState, useEffect, useRef, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle, MessagesSquare, PhoneCall, Image, Voicemail, NotebookPen, Globe, ChevronDown, ChevronUp, ChevronRight, Loader2, X, ZoomIn } from 'lucide-react';
import type { TimelineAttachment, TimelineEntry } from '../../types/timeline';
import { TYPE_COLORS } from './TimelineTypeChips';
import { formatTime, formatDate, formatDuration } from '../../lib/dates';
import { whatsAppMediaLabel, whatsAppSender, whatsAppText } from '../../lib/timelineExport';
import { sidecarCall } from '../../lib/ipc';
import { attachmentSummary } from '../../lib/attachmentSummary';
import { useNearScreen } from '../../hooks/useNearScreen';
import AmrPlayer from '../voicemail/AmrPlayer';
import MediaAttachment, { type MediaSource } from '../explore/MediaAttachment';
import type { BubbleAttachment } from '../explore/ChatBubble';

/**
 * A card's pop-ups sit over the whole window, not inside the scrolling stream:
 * a fixed element inside the stream's pane would hide a photo viewer opened from
 * it, and the pane would keep its pictures from ever counting as near the screen.
 */
function Overlay({ children }: { children: ReactElement }) {
  return typeof document === 'undefined' || !document.body ? children : createPortal(children, document.body);
}

/** Escape closes a pop-up, unless something opened over it (a photo viewer) already took it. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
}

// ── A message's files ─────────────────────────────────────────────────────────

// As many as fit on a card's row; the rest are in the message's own view
const TILES = 4;

/**
 * A message's photos, videos, voice messages and documents as small tiles on
 * its card, each opening on its own (full-size photo, video player, sound,
 * document) without opening the card. Thumbnails load as they near the screen.
 */
function AttachmentTiles({ attachments, source, udid, isMine, messageType, onMore }: {
  attachments: TimelineAttachment[];
  source: MediaSource;
  udid: string;
  isMine: boolean;
  messageType: string;
  onMore: () => void;
}) {
  const shown = attachments.slice(0, TILES);
  const rest = attachments.length - shown.length;
  return (
    // A tile's own clicks (and its viewer's) are its own, not the card's
    <div className="flex flex-wrap items-center gap-2 mt-2" onClick={e => e.stopPropagation()}>
      {shown.map(a => (
        <MediaAttachment
          key={a.attachment_id}
          udid={udid}
          attachment={a as BubbleAttachment}
          isMine={isMine}
          messageType={messageType}
          source={source}
          size="tile"
        />
      ))}
      {rest > 0 && (
        <button
          type="button"
          onClick={onMore}
          className="h-[72px] px-3 rounded-lg bg-surface border border-rule text-sm text-text-secondary hover:bg-elevated"
        >
          +{rest} more
        </button>
      )}
    </div>
  );
}

// ── Full-size photo lightbox ───────────────────────────────────────────────────

interface LightboxProps {
  fileHash: string;
  udid: string;
  filename: string;
  onClose: () => void;
}

/** A photo full size over everything; Escape or a click outside closes it. */
export function TimelinePhotoLightbox({ fileHash, udid, filename, onClose }: LightboxProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sidecarCall<{ data: string; mime_type: string; error?: string }>('get_photo', { udid, file_hash: fileHash })
      .then(r => {
        if (cancelled) return;
        if (r.error) { setError(r.error); return; }
        if (r.data) setSrc(`data:${r.mime_type || 'image/jpeg'};base64,${r.data}`);
        else setError('Image data not available');
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load image'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fileHash, udid]);

  useEscape(onClose);

  return (
    <Overlay>
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { e.stopPropagation(); onClose(); }}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute', top: 16, right: 16,
          background: 'rgba(255,255,255,0.12)',
          border: 'none', borderRadius: '50%',
          width: 36, height: 36,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', cursor: 'pointer',
        }}
      >
        <X size={18} />
      </button>

      {/* Image / states */}
      <div
        style={{ maxWidth: '90vw', maxHeight: '85vh', position: 'relative' }}
        onClick={e => e.stopPropagation()}
      >
        {loading && (
          <div style={{ color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Loader2 size={20} className="animate-spin" /> Loading…
          </div>
        )}
        {error && (
          <div style={{ color: '#ff6b6b', fontSize: 14 }}>{error}</div>
        )}
        {src && (
          <img
            src={src}
            alt={filename}
            style={{
              maxWidth: '90vw', maxHeight: '85vh',
              objectFit: 'contain',
              borderRadius: 6,
              boxShadow: '0 8px 48px rgba(0,0,0,0.6)',
              display: 'block',
            }}
          />
        )}
      </div>

      {/* Filename caption */}
      {src && (
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, marginTop: 10 }}>
          {filename}
        </div>
      )}
    </div>
    </Overlay>
  );
}

// ── Message viewer modal ──────────────────────────────────────────────────────

interface MessageViewerProps {
  text: string | null;
  displayText: string;
  isFromMe: boolean;
  conversationName: string;
  service: string;
  timestamp: string;
  onClose: () => void;
  /** Who said it, when that isn't the conversation itself (someone in a group). */
  sender?: string;
  /** Opens the whole conversation at this message, with this button label. */
  openLabel?: string;
  onOpen?: () => void;
  /** The message's files, shown full width under its words. */
  attachments?: TimelineAttachment[];
  source?: MediaSource;
  udid?: string;
  messageType?: string;
}

function MessageViewerModal({
  text, displayText, isFromMe, conversationName, service, timestamp, onClose, sender, openLabel, onOpen,
  attachments, source, udid, messageType,
}: MessageViewerProps) {
  useEscape(onClose);

  const isSpecial = !text || displayText !== text;

  return (
    <Overlay>
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={e => { e.stopPropagation(); onClose(); }}
    >
      <div
        style={{
          background: 'var(--bg-base)',
          border: '0.5px solid var(--border-default)',
          borderRadius: 12,
          width: '100%', maxWidth: 560,
          maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 16px 64px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '0.5px solid var(--border-default)',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {isFromMe ? `Me → ${conversationName}` : sender ? `${sender} → ${conversationName}` : conversationName}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {service} · {formatDate(timestamp)} at {formatTime(timestamp)}
            </div>
          </div>
          {onOpen && (
            <button
              onClick={e => { e.stopPropagation(); onOpen(); }}
              className="hearth-ghost-btn"
              style={{ marginLeft: 'auto', marginRight: 10, flexShrink: 0 }}
            >
              {openLabel ?? 'Open'}
              <ChevronRight size={16} />
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg-elevated)', border: 'none', borderRadius: '50%',
              width: 30, height: 30,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body: its own scroll pane, so its pictures load as they come into view */}
        <div data-scroll-root style={{
          flex: 1, overflowY: 'auto',
          padding: '16px 20px',
          fontSize: 15, color: isSpecial ? 'var(--text-tertiary)' : 'var(--text-primary)',
          fontStyle: isSpecial ? 'italic' : 'normal',
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {displayText}
          {attachments && attachments.length > 0 && source && udid && (
            <div className="flex flex-wrap gap-3 mt-3 not-italic">
              {attachments.map(a => (
                <MediaAttachment
                  key={a.attachment_id}
                  udid={udid}
                  attachment={a as BubbleAttachment}
                  isMine={false}
                  messageType={messageType ?? ''}
                  source={source}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </Overlay>
  );
}

// ── Note viewer modal ─────────────────────────────────────────────────────────

interface NoteViewerProps {
  title: string;
  body: string;
  modified: string;
  onClose: () => void;
}

function NoteViewerModal({ title, body, modified, onClose }: NoteViewerProps) {
  useEscape(onClose);

  return (
    <Overlay>
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={e => { e.stopPropagation(); onClose(); }}
    >
      <div
        style={{
          background: 'var(--bg-base)',
          border: '0.5px solid var(--border-default)',
          borderRadius: 12,
          width: '100%', maxWidth: 600,
          maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 16px 64px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '0.5px solid var(--border-default)',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 2 }}>
              Modified: {formatDate(modified)}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg-elevated)', border: 'none', borderRadius: '50%',
              width: 30, height: 30,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{
          flex: 1, overflowY: 'auto',
          padding: '16px 20px',
          fontSize: 15, color: 'var(--text-primary)',
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {body || <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>No content</span>}
        </div>
      </div>
    </div>
    </Overlay>
  );
}

// ── Type config ───────────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  message:   { color: TYPE_COLORS.message,   icon: MessageCircle, badge: 'Message'   },
  whatsapp:  { color: TYPE_COLORS.whatsapp,  icon: MessagesSquare, badge: 'WhatsApp' },
  call:      { color: TYPE_COLORS.call,      icon: PhoneCall,     badge: 'Call'      },
  photo:     { color: TYPE_COLORS.photo,     icon: Image,         badge: 'Photo'     },
  voicemail: { color: TYPE_COLORS.voicemail, icon: Voicemail,     badge: 'Voicemail' },
  note:      { color: TYPE_COLORS.note,      icon: NotebookPen,   badge: 'Note'      },
  browser:   { color: TYPE_COLORS.browser,   icon: Globe,         badge: 'Web'       },
};

function accentColor(entry: TimelineEntry): string {
  if (entry.type === 'call' && entry.call?.status === 'missed') return 'var(--error)';
  if (entry.type === 'whatsapp' && entry.whatsapp?.call?.outcome === 'missed') return 'var(--error)';
  return TYPE_CONFIG[entry.type].color;
}

// ── Thumbnail for photos ───────────────────────────────────────────────────────

// Thumbnails already read, so scrolling back up doesn't ask the engine again
const photoThumbs = new Map<string, string>();
const PHOTO_THUMB_CACHE = 500;

function PhotoThumb({ fileHash, udid, kind, onClick }: { fileHash: string; udid: string; kind: string; onClick?: () => void }) {
  const key = `${udid}:${fileHash}`;
  const [src, setSrc] = useState<string | null>(() => photoThumbs.get(key) ?? null);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The engine answers one call at a time: ask only for thumbnails about to be seen
  const near = useNearScreen(ref);
  const isVideo = kind === 'video' || kind === 'live_photo';
  const isClickable = !isVideo && !!onClick;

  useEffect(() => {
    if (isVideo || !near || src) return; // videos have no image thumbnail
    let cancelled = false;
    sidecarCall<{ data: string; error?: string; is_video?: boolean }>('get_photo_thumbnail', { udid, file_hash: fileHash, size: 64 })
      .then(r => {
        if (!r.data || r.is_video) return;
        const url = `data:image/jpeg;base64,${r.data}`;
        photoThumbs.set(key, url);
        if (photoThumbs.size > PHOTO_THUMB_CACHE) photoThumbs.delete(photoThumbs.keys().next().value as string);
        if (!cancelled) setSrc(url);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [key, fileHash, udid, isVideo, near, src]);

  return (
    <div
      ref={ref}
      style={{
        width: 48, height: 48,
        borderRadius: 6,
        background: 'var(--bg-elevated)',
        overflow: 'hidden',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-tertiary)',
        position: 'relative',
        cursor: isClickable ? 'zoom-in' : 'default',
      }}
      onClick={isClickable ? onClick : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {src
        ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : isVideo
          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          : <Image size={18} strokeWidth={1.5} />
      }
      {/* Zoom overlay on hover (images only) */}
      {isClickable && hovered && src && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <ZoomIn size={16} color="#fff" />
        </div>
      )}
    </div>
  );
}

// ── Inline voicemail player ───────────────────────────────────────────────────

interface VoicemailPlayerProps {
  voicemailId: number;
  udid: string;
}

function VoicemailPlayer({ voicemailId, udid }: VoicemailPlayerProps) {
  const [audioData, setAudioData] = useState<{ data: string; mime_type: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sidecarCall<{ data: string; mime_type: string }>('get_voicemail_audio', { udid, voicemail_id: voicemailId })
      .then(r => {
        if (cancelled) return;
        if (r.data) setAudioData(r);
        else setError('Audio not available');
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load audio'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [voicemailId, udid]);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: 'var(--text-tertiary)', padding: '6px 0' }}>
      <Loader2 size={16} className="animate-spin" /> Loading audio…
    </div>
  );
  if (error) return (
    <div style={{ fontSize: 14, color: 'var(--error)', padding: '4px 0' }}>{error}</div>
  );
  if (!audioData) return null;
  return <AmrPlayer base64Data={audioData.data} mimeType={audioData.mime_type} />;
}

// ── Entry card ─────────────────────────────────────────────────────────────────

interface Props {
  entry: TimelineEntry;
  udid: string;
  /** Opens a WhatsApp message in its chat. Without it, the message still shows, just with no way through to the chat. */
  onOpenWhatsApp?: (entry: TimelineEntry) => void;
  /** Opens a text message in its conversation on the Messages screen. */
  onOpenMessage?: (entry: TimelineEntry) => void;
}

// Drawn again only when its own entry changes: a stream holds thousands of cards
export default memo(TimelineEntryCard);

function TimelineEntryCard({ entry, udid, onOpenWhatsApp, onOpenMessage }: Props) {
  const [vmExpanded, setVmExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [msgOpen, setMsgOpen] = useState(false);
  const color = accentColor(entry);
  const { icon: Icon, badge } = TYPE_CONFIG[entry.type];

  const metaLeft = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Icon size={18} style={{ color, flexShrink: 0 }} />
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>{badge}</span>
      <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
        · {formatTime(entry.timestamp)}
        {entry.type === 'message' && entry.message?.service && entry.message.service !== 'iMessage' && ` · ${entry.message.service}`}
      </span>
    </div>
  );

  let body: React.ReactNode = null;

  if (entry.type === 'message' && entry.message) {
    const { text, isFromMe, conversationName, service, messageType, eventText, attachments } = entry.message;
    const files = attachments ?? [];
    // Its words; else what its files are ("Photo", "2 videos", "Voice message"); else what it was
    const filesLine = attachmentSummary(files, messageType);
    const displayText = text ? text
      : filesLine ? filesLine
      : messageType === 'app' ? '📱 App message'
      : messageType === 'attachment' ? '📎 Attachment'
      : messageType === 'audio' ? '🎙 Audio message'
      : messageType === 'location' ? '📍 Location'
      : eventText ? eventText
      : '(no text)';

    body = (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          {metaLeft}
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 1 }}>
          {isFromMe ? `Me → ${conversationName}` : conversationName}
        </div>
        <div style={{
          fontSize: 14, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontStyle: !text && filesLine ? 'italic' : 'normal',
        }}>
          {displayText}
        </div>
        {files.length > 0 && (
          <AttachmentTiles
            attachments={files}
            source="messages"
            udid={udid}
            isMine={isFromMe}
            messageType={messageType}
            onMore={() => setMsgOpen(true)}
          />
        )}
        {msgOpen && (
          <MessageViewerModal
            text={text}
            displayText={text || (files.length > 0 ? '' : displayText)}
            isFromMe={isFromMe}
            conversationName={conversationName}
            service={service}
            timestamp={entry.timestamp}
            onClose={() => setMsgOpen(false)}
            attachments={files}
            source="messages"
            udid={udid}
            messageType={messageType}
            openLabel="Open in Messages"
            onOpen={onOpenMessage && entry.message.chatId != null ? () => { setMsgOpen(false); onOpenMessage(entry); } : undefined}
          />
        )}
      </>
    );
  } else if (entry.type === 'whatsapp' && entry.whatsapp) {
    const w = entry.whatsapp;
    const { text, isFromMe, conversationName } = w;
    // Someone in a group said it: "Ana → Family". A notice ("Riley joined") is no one's.
    const sender = whatsAppSender(w) ?? undefined;
    const hasWords = !!text?.trim();
    const shown = whatsAppText(w) || '(no text)';
    const label = hasWords ? whatsAppMediaLabel(w) : null;
    const waFiles = w.attachments ?? [];

    body = (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          {metaLeft}
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isFromMe ? `Me → ${conversationName}` : sender ? `${sender} → ${conversationName}` : conversationName}
        </div>
        <div style={{
          fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--text-secondary)', fontStyle: hasWords ? 'normal' : 'italic',
        }}>
          {shown}
        </div>
        {waFiles.length > 0 && (
          <AttachmentTiles
            attachments={waFiles}
            source="whatsapp"
            udid={udid}
            isMine={isFromMe}
            messageType={w.messageType}
            onMore={() => setMsgOpen(true)}
          />
        )}
        {msgOpen && (
          <MessageViewerModal
            text={text}
            displayText={hasWords ? text! : waFiles.length > 0 ? '' : shown}
            attachments={waFiles}
            source="whatsapp"
            udid={udid}
            messageType={w.messageType}
            isFromMe={isFromMe}
            conversationName={conversationName}
            sender={sender}
            // A caption's photo: named in the line under the title
            service={label && w.messageType !== 'link' ? `WhatsApp · ${label}` : 'WhatsApp'}
            timestamp={entry.timestamp}
            onClose={() => setMsgOpen(false)}
            openLabel="Open in WhatsApp"
            onOpen={onOpenWhatsApp ? () => { setMsgOpen(false); onOpenWhatsApp(entry); } : undefined}
          />
        )}
      </>
    );
  } else if (entry.type === 'call' && entry.call) {
    const { direction, status, duration, app } = entry.call;
    const isMissed = status === 'missed';
    const dirLabel = direction === 'incoming' ? 'Incoming' : direction === 'outgoing' ? 'Outgoing' : '';
    const statusLabel = status === 'answered' ? 'Answered' : status === 'missed' ? 'Missed' : '';
    // Strip team-ID prefix from bundle IDs: "T84QZS65DQ.com.facebook.Facebook" → "Facebook"
    const appLabel = app && app !== 'Phone' && app !== 'com.apple.mobilephone'
      ? app.replace(/^[A-Z0-9]{10}\./, '').split('.').pop() || app
      : null;

    body = (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          {metaLeft}
          <span style={{ fontSize: 13, color: isMissed ? 'var(--error)' : 'var(--text-secondary)', flexShrink: 0 }}>
            {[dirLabel, statusLabel].filter(Boolean).join(' · ')}
            {!isMissed && duration > 0 && `  ·  ${formatDuration(duration)}`}
          </span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)' }}>
          {entry.contactName || entry.contactIdentifier || 'Unknown'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 1 }}>
          {entry.contactIdentifier && <span>{entry.contactIdentifier}</span>}
          {appLabel && <span>{entry.contactIdentifier ? ` · ${appLabel}` : appLabel}</span>}
        </div>
      </>
    );
  } else if (entry.type === 'photo' && entry.photo) {
    const { filename, fileHash, kind, width, height, duration } = entry.photo;
    const kindLabel = kind === 'video' ? 'Video' : kind === 'live_photo' ? 'Live Photo' : kind === 'screenshot' ? 'Screenshot' : kind === 'selfie' ? 'Selfie' : 'Photo';
    const dims = width && height ? ` · ${width} × ${height}` : '';
    const dur = duration > 0 ? ` · ${formatDuration(duration)}` : '';

    body = (
      <>
        <div style={{ marginBottom: 6 }}>{metaLeft}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <PhotoThumb
            fileHash={fileHash}
            udid={udid}
            kind={kind}
            onClick={kind !== 'video' && kind !== 'live_photo' ? () => setLightboxOpen(true) : undefined}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {filename}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 1 }}>
              {kindLabel}{dims}{dur}
            </div>
          </div>
        </div>
        {lightboxOpen && (
          <TimelinePhotoLightbox
            fileHash={fileHash}
            udid={udid}
            filename={filename}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    );
  } else if (entry.type === 'voicemail' && entry.voicemail) {
    const { duration, transcript, phoneNumber } = entry.voicemail;
    // Extract the raw numeric ID from "voicemail:42"
    const vmId = parseInt(entry.id.split(':')[1], 10);

    body = (
      <>
        {/* Clickable header row */}
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2, cursor: 'pointer' }}
          onClick={() => setVmExpanded(x => !x)}
        >
          {metaLeft}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{formatDuration(duration)}</span>
            {vmExpanded
              ? <ChevronUp size={16} style={{ color: 'var(--text-tertiary)' }} />
              : <ChevronDown size={16} style={{ color: 'var(--text-tertiary)' }} />}
          </div>
        </div>
        <div
          style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', cursor: 'pointer' }}
          onClick={() => setVmExpanded(x => !x)}
        >
          {entry.contactName || phoneNumber}
        </div>
        {transcript && (
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            "{transcript}"
          </div>
        )}
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 1 }}>{phoneNumber}</div>

        {/* Expanded player */}
        {vmExpanded && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border-subtle)' }}>
            <VoicemailPlayer voicemailId={vmId} udid={udid} />
          </div>
        )}
      </>
    );
  } else if (entry.type === 'note' && entry.note) {
    const { title, bodyPreview, body: noteBody, modified } = entry.note;

    body = (
      <>
        <div style={{ marginBottom: 2 }}>{metaLeft}</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)' }}>
          {title}
        </div>
        {bodyPreview && (
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {bodyPreview}
          </div>
        )}
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 1 }}>
          Modified: {formatDate(modified)}
        </div>
        {noteOpen && (
          <NoteViewerModal
            title={title}
            body={noteBody}
            modified={modified}
            onClose={() => setNoteOpen(false)}
          />
        )}
      </>
    );
  } else if (entry.type === 'browser' && entry.browser) {
    const { url, title, domain, browserName } = entry.browser;
    const browserLabel = browserName === 'firefox' ? 'Firefox' : 'Safari';

    body = (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
          {metaLeft}
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)', flexShrink: 0 }}>{browserLabel}</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || domain}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
          {domain || url}
        </div>
      </>
    );
  }

  const isClickable = entry.type === 'voicemail' || entry.type === 'note' || entry.type === 'message' || entry.type === 'whatsapp';

  function handleCardClick() {
    if (entry.type === 'note') setNoteOpen(true);
    else if (entry.type === 'message' || entry.type === 'whatsapp') setMsgOpen(true);
  }

  return (
    <div
      data-entry-id={entry.id}
      style={{
        display: 'flex',
        borderRadius: 10,
        border: '1px solid var(--border-default)',
        background: 'var(--bg-base)',
        overflow: 'hidden',
        cursor: isClickable ? 'pointer' : 'default',
        transition: 'background 0.12s',
      }}
      onClick={isClickable ? handleCardClick : undefined}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-base)')}
    >
      {/* Color accent bar */}
      <div style={{ width: 4, flexShrink: 0, background: color }} />
      {/* Content */}
      <div style={{ flex: 1, padding: '10px 14px', minWidth: 0 }}>
        {body}
      </div>
    </div>
  );
}
