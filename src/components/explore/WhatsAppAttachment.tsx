import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { ExternalLink, FileText, ImageOff, Mic, Music, Play, X } from 'lucide-react';
import { sidecarCall } from '../../lib/ipc';
import {
  attachmentKind, documentName, durationText, fileTypeLabel, fitBox, formatBytes, handOver, kindLabel, missingText,
  playsInApp, splitExtension, type AttachmentKind,
} from '../../lib/whatsapp';
import type { WhatsAppAttachmentResult } from '../../types/whatsapp';
import type { AttachmentProps, MapPreviewProps } from './ChatBubble';

/*
 * WhatsApp's photos, videos, voice messages, documents and map previews in a
 * chat. Files come from get_whatsapp_attachment, never Messages'
 * get_attachment: the ids are from a different database and the same number
 * there is somebody else's file.
 *
 * The engine answers one call at a time, so a page of 200 messages mustn't ask
 * for 200 full-size photos at once: pictures load small (WhatsApp's own
 * thumbnails) when they scroll near the screen, full size only when clicked,
 * and sound only when Play is pressed. Videos and documents open in the
 * computer's own apps, but only the kinds the engine says are safe to open: a
 * program or script someone sent is shown in its folder, never run. Files
 * that aren't in the backup are never asked for.
 */

type Loaded = { url: string } | { missing: true } | { tooLarge: true } | { error: string };

// Pictures already read, so scrolling back or reopening a chat doesn't ask again.
// Thumbnails are small; full-size photos are kept only a few at a time.
const thumbs = new Map<string, Loaded>();
const fulls = new Map<string, Loaded>();
const inFlight = new Map<string, Promise<Loaded>>();
const THUMB_CACHE = 400;
const FULL_CACHE = 12;

function remember(cache: Map<string, Loaded>, max: number, key: string, value: Loaded) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value as string);
}

function ask(udid: string, attachmentId: number, opts: { thumbnail?: boolean; as_file?: boolean } = {}) {
  return sidecarCall<WhatsAppAttachmentResult>('get_whatsapp_attachment', { udid, attachment_id: attachmentId, ...opts });
}

function readResult(r: WhatsAppAttachmentResult | null | undefined): Loaded {
  if (!r) return { error: 'No answer from the engine' };
  if (r.empty_reason === 'not_in_backup') return { missing: true };
  if (r.error) return { error: r.error };
  if (r.too_large) return { tooLarge: true };
  if (!r.data) return { error: "The file couldn't be read" };
  return { url: `data:${r.mime_type || 'application/octet-stream'};base64,${r.data}` };
}

/** A picture as a data: URL, read once and kept. Errors aren't kept, so a later look tries again. */
function loadPicture(udid: string, attachmentId: number, thumbnail: boolean): Promise<Loaded> {
  const key = `${udid}:${attachmentId}:${thumbnail ? 'thumb' : 'full'}`;
  const cache = thumbnail ? thumbs : fulls;
  const known = cache.get(key);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = ask(udid, attachmentId, thumbnail ? { thumbnail: true } : {})
    .then(readResult, (e: unknown) => ({ error: String((e as Error)?.message ?? e) }) as Loaded)
    .then(loaded => {
      if (!('error' in loaded)) remember(cache, thumbnail ? THUMB_CACHE : FULL_CACHE, key, loaded);
      return loaded;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Copy the file out of the backup with its real name and open it in the app
 * the computer uses for it, or, when it's a kind of file that would run
 * rather than open (a program, a script), show it in its folder. Resolves to
 * what to tell the person, or null.
 */
async function openInApp(udid: string, attachmentId: number): Promise<string | null> {
  try {
    const r = await ask(udid, attachmentId, { as_file: true });
    return await handOver(r, window.openextract);
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

/** True once the element is near the visible part of the chat (or straight away where that can't be told). */
function useNearScreen(ref: RefObject<Element>): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (near || !el || typeof IntersectionObserver === 'undefined') return;
    // The chat scrolls inside its own pane: watch against that, a screen or so ahead
    const root = el.closest('[data-thread-scroll]');
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { root, rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

function muted(isMine: boolean) {
  return isMine ? 'text-white/75' : 'text-text-tertiary';
}

/** "Opening…", or why it didn't open, under a file. */
function Status({ text, isMine }: { text: string | null; isMine: boolean }) {
  if (!text) return null;
  return <div role="status" className={`text-xs mt-1 ${muted(isMine)}`}>{text}</div>;
}

/**
 * True while the component is on screen, for work that finishes after an
 * await. Set in the effect itself, not only at first render: in development
 * React mounts, unmounts and mounts again, and a flag only ever cleared would
 * stay false after that.
 */
export function useAlive(): RefObject<boolean> {
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}

export function useOpener(udid: string, attachmentId: number) {
  const [status, setStatus] = useState<string | null>(null);
  const alive = useAlive();
  async function open() {
    setStatus('Opening…');
    const said = await openInApp(udid, attachmentId);
    if (alive.current) setStatus(said);
  }
  return { status, open };
}

/**
 * A dialog over the chat takes focus when it opens (to `first`) and gives it
 * back to what had it (the thumbnail) when it closes, as a dialog should for
 * keyboard and screen reader users.
 */
export function useDialogFocus(first: RefObject<HTMLElement>) {
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    first.current?.focus();
    return () => {
      if (back && back.isConnected !== false && typeof back.focus === 'function') back.focus();
    };
  }, []);
}

/** Tab and Shift+Tab go round the dialog's buttons instead of into the chat behind it. */
export function keepTabInside(
  e: Pick<ReactKeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
  dialog: Pick<HTMLElement, 'querySelectorAll' | 'contains'> | null,
  active: Element | null,
) {
  if (e.key !== 'Tab' || !dialog) return;
  const stops = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
  if (stops.length === 0) return;
  const first = stops[0], last = stops[stops.length - 1];
  const inside = !!active && dialog.contains(active);
  if (!inside || (e.shiftKey ? active === first : active === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

// ── Not in the backup ──────────────────────────────────────────────────────

function Missing({ kind, attachment, isMine }: { kind: AttachmentKind; attachment: AttachmentProps['attachment']; isMine: boolean }) {
  const name = kind === 'document' ? documentName(attachment) : '';
  const Glyph = kind === 'image' || kind === 'sticker' ? ImageOff : kind === 'voice' ? Mic : kind === 'audio' ? Music : kind === 'document' ? FileText : Play;
  return (
    <div className={`flex items-start gap-2 text-xs italic ${muted(isMine)}`}>
      <Glyph size={15} className="flex-shrink-0 mt-px" />
      <span className="min-w-0">
        {name && <span className="block not-italic font-medium truncate">{name}</span>}
        {missingText(kind, attachment.transfer_name)}
      </span>
    </div>
  );
}

// ── Photos and stickers ────────────────────────────────────────────────────

export function Viewer({ udid, attachment, label, onClose }: {
  udid: string;
  attachment: AttachmentProps['attachment'];
  label: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const opener = useOpener(udid, attachment.attachment_id);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(closeRef);

  useEffect(() => {
    let live = true;
    loadPicture(udid, attachment.attachment_id, false).then(l => {
      if (!live) return;
      setLoaded(l);
      // Too big to show here: hand it to the computer's photo viewer instead
      if ('tooLarge' in l) opener.open();
    });
    return () => { live = false; };
  }, [udid, attachment.attachment_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-6 gap-3"
      onClick={onClose}
      onKeyDown={e => keepTabInside(e, dialogRef.current, document.activeElement)}
    >
      <div className="flex-1 min-h-0 w-full flex items-center justify-center" onClick={e => e.stopPropagation()}>
        {!loaded && <div className="text-white/80 text-sm">Loading…</div>}
        {loaded && 'url' in loaded && (
          <img src={loaded.url} alt={label} className="max-w-full max-h-full object-contain rounded-lg" />
        )}
        {loaded && 'tooLarge' in loaded && (
          <div className="text-white/90 text-sm text-center">This photo is too big to show here, so it opens in another app.</div>
        )}
        {loaded && 'missing' in loaded && <div className="text-white/90 text-sm">{missingText('image')}</div>}
        {loaded && 'error' in loaded && <div className="text-white/90 text-sm text-center">Couldn't show this photo: {loaded.error}</div>}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0" onClick={e => e.stopPropagation()}>
        <button type="button" onClick={opener.open} className="hearth-ghost-btn !bg-white !text-text-primary">
          <ExternalLink size={16} />
          Open in another app
        </button>
        <button ref={closeRef} type="button" onClick={onClose} className="hearth-ghost-btn !bg-white !text-text-primary" aria-label="Close">
          <X size={16} />
          Close
        </button>
      </div>
      {opener.status && <div role="status" className="text-white/80 text-xs" onClick={e => e.stopPropagation()}>{opener.status}</div>}
    </div>
  );
}

function Picture({ udid, attachment, kind, isMine }: {
  udid: string; attachment: AttachmentProps['attachment']; kind: 'image' | 'sticker'; isMine: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearScreen(ref);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [viewing, setViewing] = useState(false);
  const opener = useOpener(udid, attachment.attachment_id);
  const sticker = kind === 'sticker';
  // The picture's space is set before it loads (its own shape when known, else a fixed
  // box it's cropped into), so the chat doesn't move as pictures arrive above what's on screen
  const box = sticker ? { width: 128, height: 128 } : fitBox(attachment.width, attachment.height, 240, 256) ?? { width: 200, height: 150 };
  const label = documentName(attachment) || kindLabel(kind);

  useEffect(() => {
    if (!near) return;
    let live = true;
    (async () => {
      let l = await loadPicture(udid, attachment.attachment_id, !!attachment.thumbnail_path);
      // No thumbnail after all: the picture itself, if it's small enough
      if (attachment.thumbnail_path && 'missing' in l) l = await loadPicture(udid, attachment.attachment_id, false);
      if (live) setLoaded(l);
    })();
    return () => { live = false; };
  }, [near, udid, attachment.attachment_id, attachment.thumbnail_path]);

  if (loaded && 'missing' in loaded) return <Missing kind={kind} attachment={attachment} isMine={isMine} />;

  const failed = loaded && ('error' in loaded || 'tooLarge' in loaded);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => (failed && 'tooLarge' in loaded! ? opener.open() : setViewing(true))}
        title={sticker ? label : `Show the ${label === 'Photo' ? 'photo' : label} full size`}
        aria-label={sticker ? label : `${label}, show full size`}
        className={`block mt-1 rounded-lg overflow-hidden ${loaded && 'url' in loaded ? '' : isMine ? 'bg-white/15' : 'bg-black/5'}`}
        style={{ width: box.width, height: box.height }}
      >
        {loaded && 'url' in loaded ? (
          <img
            src={loaded.url}
            alt={label}
            className={`w-full h-full ${sticker ? 'object-contain' : 'object-cover'}`}
            onError={() => setLoaded({ error: "The picture couldn't be shown" })}
          />
        ) : failed ? (
          <span className={`w-full h-full flex flex-col items-center justify-center gap-1 text-xs px-2 ${muted(isMine)}`}>
            <ImageOff size={20} />
            {'tooLarge' in loaded! ? 'Too big to show here: open it' : "Couldn't show it"}
          </span>
        ) : null}
      </button>
      <Status text={opener.status} isMine={isMine} />
      {viewing && <Viewer udid={udid} attachment={attachment} label={label} onClose={() => setViewing(false)} />}
    </>
  );
}

// ── Videos and GIFs ────────────────────────────────────────────────────────

function VideoTile({ udid, attachment, kind, isMine }: {
  udid: string; attachment: AttachmentProps['attachment']; kind: 'video' | 'gif'; isMine: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearScreen(ref);
  const [poster, setPoster] = useState<string | null>(null);
  const opener = useOpener(udid, attachment.attachment_id);
  const label = kindLabel(kind);
  const length = attachment.duration ? durationText(attachment.duration) : '';

  useEffect(() => {
    if (!near || !attachment.thumbnail_path) return;
    let live = true;
    loadPicture(udid, attachment.attachment_id, true).then(l => { if (live && 'url' in l) setPoster(l.url); });
    return () => { live = false; };
  }, [near, udid, attachment.attachment_id, attachment.thumbnail_path]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={opener.open}
        title={`Play the ${label.toLowerCase()} in another app`}
        aria-label={`Play ${label.toLowerCase()}${length ? `, ${length}` : ''}`}
        className={`relative block mt-1 rounded-lg overflow-hidden ${isMine ? 'bg-white/15' : 'bg-black/5'}`}
        style={{ width: 200, height: 150 }}
      >
        {poster && <img src={poster} alt="" className="w-full h-full object-cover block" />}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="w-11 h-11 rounded-full bg-black/55 flex items-center justify-center">
            <Play size={20} className="text-white ml-0.5" />
          </span>
        </span>
        <span className="absolute left-2 bottom-1.5 text-xs text-white font-medium drop-shadow">
          {label}{length && ` · ${length}`}
        </span>
      </button>
      <Status text={opener.status} isMine={isMine} />
    </>
  );
}

// ── Voice messages and audio ───────────────────────────────────────────────

export function Sound({ udid, attachment, kind, isMine }: {
  udid: string; attachment: AttachmentProps['attachment']; kind: 'voice' | 'audio'; isMine: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'cant-play'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const opener = useOpener(udid, attachment.attachment_id);
  const alive = useAlive();
  const label = kind === 'voice' ? 'voice message' : 'audio';
  const length = attachment.duration ? durationText(attachment.duration) : '';

  // A blob URL holds the sound in memory until it's let go
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  async function play() {
    if (!playsInApp(attachment)) { opener.open(); return; }
    setState('loading');
    setProblem(null);
    try {
      const r = await ask(udid, attachment.attachment_id);
      // Gone from the screen while it loaded (another chat picked): nothing would ever let a blob go
      if (!alive.current) return;
      const l = readResult(r);
      if ('tooLarge' in l) { setState('idle'); opener.open(); return; }
      if ('missing' in l) { setState('idle'); setProblem(missingText(kind)); return; }
      if ('error' in l) { setState('idle'); setProblem(l.error); return; }
      const bin = atob(r.data!);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      setSrc(URL.createObjectURL(new Blob([bytes], { type: r.mime_type || 'audio/ogg' })));
      setState('idle');
    } catch (e) {
      if (!alive.current) return;
      setState('idle');
      setProblem(String((e as Error)?.message ?? e));
    }
  }

  if (src && state !== 'cant-play') {
    return (
      <audio
        controls
        autoPlay
        src={src}
        aria-label={kind === 'voice' ? 'Voice message' : 'Audio'}
        className="mt-1 w-64 max-w-full"
        onError={() => setState('cant-play')}
      />
    );
  }

  const Glyph = kind === 'voice' ? Mic : Music;
  return (
    <>
      <button
        type="button"
        onClick={state === 'cant-play' ? opener.open : play}
        disabled={state === 'loading'}
        className={`mt-1 flex items-center gap-2 text-sm rounded-full pl-1.5 pr-3 py-1 ${isMine ? 'bg-white/20 hover:bg-white/25' : 'bg-black/5 hover:bg-black/10'}`}
      >
        <span className={`w-7 h-7 rounded-full flex items-center justify-center ${isMine ? 'bg-white/25' : 'bg-accent-wash'}`}>
          {state === 'loading' ? <Glyph size={14} /> : <Play size={14} className={isMine ? 'text-white' : 'text-accent'} />}
        </span>
        <span>
          {state === 'loading' ? 'Loading…' : state === 'cant-play' ? `Open the ${label} in another app` : `Play ${label}`}
          {length && state === 'idle' && <span className={muted(isMine)}> · {length}</span>}
        </span>
      </button>
      <Status text={state === 'cant-play' ? "This kind of sound can't play here." : problem ?? opener.status} isMine={isMine} />
    </>
  );
}

// ── Documents ──────────────────────────────────────────────────────────────

/**
 * A document: its name (without the invisible characters that can make
 * "Invoice.exe" read as a PDF) with its extension always in view, what kind of
 * file that extension says it is, and its size. Clicking opens it in another
 * app, or shows it in its folder when it's a kind of file that would run.
 */
export function Document({ udid, attachment, isMine }: { udid: string; attachment: AttachmentProps['attachment']; isMine: boolean }) {
  const opener = useOpener(udid, attachment.attachment_id);
  const name = documentName(attachment);
  const { stem, ext } = splitExtension(name || 'Document');
  const details = [name ? fileTypeLabel(name) : '', formatBytes(attachment.total_bytes)].filter(Boolean).join(' · ');
  return (
    <>
      <button
        type="button"
        onClick={opener.open}
        title={name || 'Document'}
        aria-label={`${name || 'Document'}${details ? `, ${details}` : ''}`}
        className={`mt-1 w-full max-w-xs flex items-center gap-2.5 text-left rounded-xl px-2.5 py-2 ${isMine ? 'bg-white/20 hover:bg-white/25' : 'bg-black/5 hover:bg-black/10'}`}
      >
        <FileText size={22} className={`flex-shrink-0 ${isMine ? 'text-white' : 'text-accent'}`} />
        <span className="min-w-0 flex-1">
          {/* A long name is cut short before its extension, so the extension stays in view */}
          <span className="flex min-w-0 text-sm font-medium">
            <span className="truncate">{stem}</span>
            {ext && <span className="flex-shrink-0">{ext}</span>}
          </span>
          {details && <span className={`block text-xs ${muted(isMine)}`}>{details}</span>}
        </span>
      </button>
      <Status text={opener.status} isMine={isMine} />
    </>
  );
}

/** One WhatsApp attachment in a chat bubble. */
export default function WhatsAppAttachment({ udid, attachment, isMine, messageType }: AttachmentProps) {
  const kind = attachmentKind(attachment, messageType);
  // Not in the backup (never downloaded, or left out): say so, and don't ask the engine for it
  if (attachment.available === false) return <Missing kind={kind} attachment={attachment} isMine={isMine} />;
  switch (kind) {
    case 'image':
    case 'sticker':
      return <Picture udid={udid} attachment={attachment} kind={kind} isMine={isMine} />;
    case 'video':
    case 'gif':
      return <VideoTile udid={udid} attachment={attachment} kind={kind} isMine={isMine} />;
    case 'voice':
    case 'audio':
      return <Sound udid={udid} attachment={attachment} kind={kind} isMine={isMine} />;
    default:
      return <Document udid={udid} attachment={attachment} isMine={isMine} />;
  }
}

/** The small map WhatsApp saved with a shared location. Nothing is fetched from the internet. */
export function WhatsAppMapPreview({ udid, location }: MapPreviewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearScreen(ref);
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!near || location.attachment_id == null) return;
    let live = true;
    loadPicture(udid, location.attachment_id, true).then(l => {
      if (!live) return;
      if ('url' in l) setUrl(l.url);
      else setGone(true);
    });
    return () => { live = false; };
  }, [near, udid, location.attachment_id]);

  if (gone) return null;
  return (
    <div ref={ref} className="rounded-lg overflow-hidden bg-black/5" style={{ width: 240, height: 140 }}>
      {url && <img src={url} alt="Map of the shared location" className="block w-full h-full object-cover" />}
    </div>
  );
}
