import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, PhoneCall, Image, Phone, FileText, Globe, ChevronDown, ChevronUp, Loader2, X, ZoomIn } from 'lucide-react';
import { TimelineEntry } from '../../types/timeline';
import { formatTime, formatDate, formatDuration } from '../../lib/dates';
import { sidecarCall } from '../../lib/ipc';
import AmrPlayer from '../voicemail/AmrPlayer';

// ── Full-size photo lightbox ───────────────────────────────────────────────────

interface LightboxProps {
  fileHash: string;
  udid: string;
  filename: string;
  onClose: () => void;
}

function TimelinePhotoLightbox({ fileHash, udid, filename, onClose }: LightboxProps) {
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

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
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
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 10 }}>
          {filename}
        </div>
      )}
    </div>
  );
}

// ── Type config ───────────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  message:   { color: '#007AFF', icon: MessageSquare, badge: 'MSG'   },
  call:      { color: '#30d158', icon: PhoneCall,     badge: 'CALL'  },
  photo:     { color: '#AF52DE', icon: Image,         badge: 'PHOTO' },
  voicemail: { color: '#ff9f0a', icon: Phone,         badge: 'VM'    },
  note:      { color: '#5AC8FA', icon: FileText,      badge: 'NOTE'  },
  browser:   { color: '#34C759', icon: Globe,         badge: 'WEB'   },
} as const;

function accentColor(entry: TimelineEntry): string {
  if (entry.type === 'call' && entry.call?.status === 'missed') return '#ff3b30';
  return TYPE_CONFIG[entry.type].color;
}

// ── Thumbnail for photos ───────────────────────────────────────────────────────

function PhotoThumb({ fileHash, udid, kind, onClick }: { fileHash: string; udid: string; kind: string; onClick?: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const isVideo = kind === 'video' || kind === 'live_photo';
  const isClickable = !isVideo && !!onClick;

  useEffect(() => {
    if (isVideo) return; // videos have no image thumbnail
    let cancelled = false;
    sidecarCall<{ data: string; error?: string; is_video?: boolean }>('get_photo_thumbnail', { udid, file_hash: fileHash, size: 64 })
      .then(r => { if (!cancelled && r.data && !r.is_video) setSrc(`data:image/jpeg;base64,${r.data}`); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fileHash, udid, isVideo]);

  return (
    <div
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)', padding: '6px 0' }}>
      <Loader2 size={13} className="animate-spin" /> Loading audio…
    </div>
  );
  if (error) return (
    <div style={{ fontSize: 12, color: 'var(--error)', padding: '4px 0' }}>{error}</div>
  );
  if (!audioData) return null;
  return <AmrPlayer base64Data={audioData.data} mimeType={audioData.mime_type} />;
}

// ── Entry card ─────────────────────────────────────────────────────────────────

interface Props {
  entry: TimelineEntry;
  udid: string;
}

export default function TimelineEntryCard({ entry, udid }: Props) {
  const [vmExpanded, setVmExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const color = accentColor(entry);
  const { icon: Icon, badge } = TYPE_CONFIG[entry.type];

  const metaLeft = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
        padding: '1px 5px', borderRadius: 3,
        background: color, color: '#fff',
      }}>
        {badge}
      </span>
      <Icon size={12} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
        {formatTime(entry.timestamp)}
      </span>
    </div>
  );

  let body: React.ReactNode = null;

  if (entry.type === 'message' && entry.message) {
    const { text, isFromMe, conversationName, service, messageType } = entry.message;
    const displayText = messageType === 'app' ? '📱 App message'
      : messageType === 'attachment' ? '📎 Attachment'
      : messageType === 'audio' ? '🎙 Audio message'
      : messageType === 'location' ? '📍 Location'
      : text ? text
      : '(no text)';

    body = (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          {metaLeft}
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 1 }}>
          {isFromMe ? `Me → ${conversationName}` : conversationName}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayText}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
          {service} · {conversationName}
        </div>
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
          <span style={{ fontSize: 11, color: isMissed ? '#ff3b30' : 'var(--text-secondary)', flexShrink: 0 }}>
            {[dirLabel, statusLabel].filter(Boolean).join(' · ')}
            {!isMissed && duration > 0 && `  ·  ${formatDuration(duration)}`}
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
          {entry.contactName || entry.contactIdentifier || 'Unknown'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
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
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {filename}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
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
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatDuration(duration)}</span>
            {vmExpanded
              ? <ChevronUp size={13} style={{ color: 'var(--text-tertiary)' }} />
              : <ChevronDown size={13} style={{ color: 'var(--text-tertiary)' }} />}
          </div>
        </div>
        <div
          style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', cursor: 'pointer' }}
          onClick={() => setVmExpanded(x => !x)}
        >
          {entry.contactName || phoneNumber}
        </div>
        {transcript && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            "{transcript}"
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>{phoneNumber}</div>

        {/* Expanded player */}
        {vmExpanded && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border-subtle)' }}>
            <VoicemailPlayer voicemailId={vmId} udid={udid} />
          </div>
        )}
      </>
    );
  } else if (entry.type === 'note' && entry.note) {
    const { title, bodyPreview, modified } = entry.note;

    body = (
      <>
        <div style={{ marginBottom: 2 }}>{metaLeft}</div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
          {title}
        </div>
        {bodyPreview && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {bodyPreview}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
          Modified: {formatDate(modified)}
        </div>
      </>
    );
  } else if (entry.type === 'browser' && entry.browser) {
    const { url, title, domain, browserName } = entry.browser;
    const browserLabel = browserName === 'firefox' ? 'Firefox' : 'Safari';

    body = (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
          {metaLeft}
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>{browserLabel}</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || domain}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
          {domain || url}
        </div>
      </>
    );
  }

  return (
    <div style={{
      display: 'flex',
      borderRadius: 8,
      border: '0.5px solid var(--border-default)',
      background: 'var(--bg-base)',
      overflow: 'hidden',
      cursor: entry.type === 'voicemail' ? 'pointer' : 'default',
      transition: 'background 0.12s',
    }}
    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
    onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-base)')}
    >
      {/* Color accent bar */}
      <div style={{ width: 3, flexShrink: 0, background: color }} />
      {/* Content */}
      <div style={{ flex: 1, padding: '8px 12px', minWidth: 0 }}>
        {body}
      </div>
    </div>
  );
}
