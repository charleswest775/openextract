import {
  useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, ImageOff, Mic, Music, Play, X } from 'lucide-react';
import { sidecarCall } from '../../lib/ipc';
import { localMediaUrl } from '../../lib/openFile';
import {
  attachmentKind, documentName, durationText, fileTypeLabel, fitBox, formatBytes, handOver, kindLabel, missingText,
  playsInApp, splitExtension, type AttachmentKind, type MediaSource,
} from '../../lib/whatsapp';
import { useNearScreen } from '../../hooks/useNearScreen';
import type { AttachmentResult } from '../../types/whatsapp';
import type { AttachmentProps, MapPreviewProps } from './ChatBubble';

/*
 * Photos, videos, voice messages, documents and stickers in a chat, from
 * Messages (sms.db, get_attachment) or WhatsApp (ChatStorage,
 * get_whatsapp_attachment). Each file is asked for from its own source only:
 * the two databases number their files separately, and the same id in the
 * other one is somebody else's file, so every cache below is keyed by source.
 *
 * The engine answers one call at a time, so a page of 200 messages mustn't ask
 * for 200 full-size photos at once: pictures load small when they scroll near
 * the screen (WhatsApp's own thumbnails, or one the engine makes from a
 * Messages photo), full size only in the viewer, sound only when Play is
 * pressed, and a video's poster frame, when there's no stored one, one at a
 * time. Each picture's space is set before it loads, so the chat doesn't move
 * as they arrive.
 *
 * Videos play in the app, from a copy the engine makes (as_file), through the
 * local-media:// protocol (electron/localMedia.ts); one that can't play here
 * (a codec this computer lacks) offers another app instead. Documents and the
 * sounds the app can't play open in the computer's own apps, but only the
 * kinds the engine says are safe to open: a program or script someone sent is
 * shown in its folder, never run. Files that aren't in the backup are never
 * asked for.
 *
 * size 'bubble' draws a file as a chat shows it; 'tile' as a small square for
 * the cards on the Timeline and People screens, where a click on the file
 * mustn't also open the card.
 */

export type { MediaSource };
export type MediaSize = 'bubble' | 'tile';

const METHOD: Record<MediaSource, string> = { messages: 'get_attachment', whatsapp: 'get_whatsapp_attachment' };

type Loaded = { url: string } | { missing: true } | { tooLarge: true } | { noThumbnail: true } | { error: string };

// Pictures already read, so scrolling back or reopening a chat doesn't ask again.
// Thumbnails and posters are small; full-size photos are kept only a few at a time.
const thumbs = new Map<string, Loaded>();
const fulls = new Map<string, Loaded>();
const inFlight = new Map<string, Promise<Loaded>>();
// A photo's own shape, learnt from its thumbnail, so its box fits it the next time it's drawn
const shapes = new Map<string, { width: number; height: number }>();
// Poster frames made from a copy of the video (null: none could be made, don't try again)
const posters = new Map<string, string | null>();
const THUMB_CACHE = 400;
const FULL_CACHE = 12;
const POSTER_CACHE = 200;

// A video is copied out of the backup to make its poster only up to this size (or when its size isn't known)
const POSTER_MAX_BYTES = 150 * 1024 * 1024;
const POSTER_PX = 480;
const TILE = 72;
// A picture whose shape isn't known yet is drawn in a box this size, cropped to fit
const UNKNOWN_SHAPE = { width: 220, height: 220 };

function remember<V>(cache: Map<string, V>, max: number, key: string, value: V) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value as string);
}

const fileKey = (source: MediaSource, udid: string, attachmentId: number) => `${source}:${udid}:${attachmentId}`;

function ask(source: MediaSource, udid: string, attachmentId: number, opts: { thumbnail?: boolean; as_file?: boolean } = {}) {
  return sidecarCall<AttachmentResult>(METHOD[source], { udid, attachment_id: attachmentId, ...opts });
}

function message(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

function readResult(r: AttachmentResult | null | undefined): Loaded {
  if (!r) return { error: 'No answer from the engine' };
  if (r.empty_reason === 'not_in_backup') return { missing: true };
  if (r.error) return { error: r.error };
  if (r.too_large) return { tooLarge: true };
  if (r.no_thumbnail) return { noThumbnail: true };
  if (!r.data) return { error: "The file couldn't be read" };
  return { url: `data:${r.mime_type || 'application/octet-stream'};base64,${r.data}` };
}

/** A picture as a data: URL, read once and kept. Errors aren't kept, so a later look tries again. */
function loadPicture(source: MediaSource, udid: string, attachmentId: number, thumbnail: boolean): Promise<Loaded> {
  const key = `${fileKey(source, udid, attachmentId)}:${thumbnail ? 'thumb' : 'full'}`;
  const cache = thumbnail ? thumbs : fulls;
  const known = cache.get(key);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = ask(source, udid, attachmentId, thumbnail ? { thumbnail: true } : {})
    .then(r => {
      if (r?.width && r?.height) remember(shapes, THUMB_CACHE, fileKey(source, udid, attachmentId), { width: r.width, height: r.height });
      return readResult(r);
    }, (e: unknown) => ({ error: message(e) }) as Loaded)
    .then(loaded => {
      if (!('error' in loaded)) remember(cache, thumbnail ? THUMB_CACHE : FULL_CACHE, key, loaded);
      return loaded;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Whether a picture is first shown from a thumbnail: WhatsApp's stored one when
 * it has one, and for Messages one the engine makes from any photo. A Messages
 * sticker is read as it is, so it keeps its see-through background.
 */
function startsSmall(source: MediaSource, attachment: AttachmentProps['attachment'], kind: AttachmentKind): boolean {
  if (source === 'whatsapp') return !!attachment.thumbnail_path;
  return kind === 'image';
}

// ── Video posters, one copy at a time ────────────────────────────────────────
// Making a poster copies the video out of the backup first, which keeps the engine busy.
// They're made one after another, and only for tiles still on screen when their turn
// comes, so a chat full of videos doesn't queue a copy of each ahead of what's clicked.

let posterLine: Promise<unknown> = Promise.resolve();
const posterPending = new Map<string, Promise<string | null | undefined>>();
const posterWanted = new Map<string, number>();

/** Whether this computer can make a poster from a copy (macOS and Windows; not Linux). */
function canMakePosters(): boolean {
  const bridge = typeof window !== 'undefined' ? window.openextract : undefined;
  return !!bridge && typeof bridge.mediaThumbnail === 'function' && (bridge.platform === 'darwin' || bridge.platform === 'win32');
}

/** A poster for the video, made from a copy of it; undefined when nobody wanted it any more by its turn. */
function makePoster(source: MediaSource, udid: string, attachmentId: number): Promise<string | null | undefined> {
  const key = fileKey(source, udid, attachmentId);
  if (posters.has(key)) return Promise.resolve(posters.get(key));
  const pending = posterPending.get(key);
  if (pending) return pending;
  const p = posterLine.then(async () => {
    if (!posterWanted.get(key)) return undefined;
    let url: string | null = null;
    try {
      const r = await ask(source, udid, attachmentId, { as_file: true });
      if (r?.path) url = (await window.openextract.mediaThumbnail(r.path, POSTER_PX)) || null;
    } catch {
      url = null; // no poster: the plain play tile
    }
    remember(posters, POSTER_CACHE, key, url);
    return url;
  }).finally(() => posterPending.delete(key));
  posterLine = p.catch(() => undefined);
  posterPending.set(key, p);
  return p;
}

/** Copy the file out of the backup and hand it to the computer (another app, or its folder). */
async function openInApp(source: MediaSource, udid: string, attachmentId: number): Promise<string | null> {
  try {
    const r = await ask(source, udid, attachmentId, { as_file: true });
    return await handOver(r, window.openextract);
  } catch (e) {
    return message(e);
  }
}

function muted(onColour: boolean) {
  return onColour ? 'text-white/75' : 'text-text-tertiary';
}

/** "Opening…", or why it didn't open, under a file. */
function Status({ text, onColour, tile = false }: { text: string | null; onColour: boolean; tile?: boolean }) {
  if (!text) return null;
  return <div role="status" className={`text-xs mt-1 ${tile ? 'max-w-[12rem]' : ''} ${muted(onColour)}`}>{text}</div>;
}

/** Viewers sit over the whole window, whatever the list they were opened from is inside. */
function Overlay({ children }: { children: ReactElement }) {
  return typeof document === 'undefined' || !document.body ? children : createPortal(children, document.body);
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

/**
 * Opening a file in another app: `open()` copies it out and hands it over;
 * `status` says "Opening…" and then what happened, or null when it opened.
 */
export function useOpener(udid: string, attachmentId: number, source: MediaSource = 'whatsapp') {
  const [status, setStatus] = useState<string | null>(null);
  const alive = useAlive();
  async function open() {
    setStatus('Opening…');
    const said = await openInApp(source, udid, attachmentId);
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

function glyphFor(kind: AttachmentKind) {
  return kind === 'image' || kind === 'sticker' ? ImageOff : kind === 'voice' ? Mic : kind === 'audio' ? Music : kind === 'document' ? FileText : Play;
}

function Missing({ kind, attachment, onColour, tile = false }: {
  kind: AttachmentKind; attachment: AttachmentProps['attachment']; onColour: boolean; tile?: boolean;
}) {
  const name = kind === 'document' ? documentName(attachment) : '';
  const Glyph = glyphFor(kind);
  const text = missingText(kind, attachment.transfer_name);
  if (tile) {
    return (
      <span
        role="img"
        aria-label={name ? `${name}: ${text}` : text}
        title={name ? `${name}: ${text}` : text}
        className="flex flex-col items-center justify-center gap-1 rounded-lg bg-black/5 text-text-tertiary text-[11px] leading-tight text-center px-1"
        style={{ width: TILE, height: TILE }}
      >
        <Glyph size={18} />
        Not in backup
      </span>
    );
  }
  return (
    <div className={`flex items-start gap-2 text-xs italic ${muted(onColour)}`}>
      <Glyph size={15} className="flex-shrink-0 mt-px" />
      <span className="min-w-0">
        {name && <span className="block not-italic font-medium truncate">{name}</span>}
        {text}
      </span>
    </div>
  );
}

// ── The viewer: a photo full size, or a video playing ──────────────────────

type Opener = ReturnType<typeof useOpener>;

/**
 * Escape closes the viewer, and only the viewer: it's heard first (capture) and
 * goes no further, so a message view it was opened from stays open, as Back from
 * a photo does on a phone. Focus goes to Close while it's open and back afterwards.
 */
function useViewerKeys(onClose: () => void, closeRef: RefObject<HTMLButtonElement>) {
  useDialogFocus(closeRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
}

/**
 * The viewer's frame: what's shown, then "Open in another app" and Close. A
 * plain function rather than a component, so the dialog is the viewer's own
 * element.
 */
function viewerFrame({ dialogRef, closeRef, label, onClose, opener, children }: {
  dialogRef: RefObject<HTMLDivElement>;
  closeRef: RefObject<HTMLButtonElement>;
  label: string;
  onClose: () => void;
  opener: Opener;
  children: ReactNode;
}) {
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      // Above every other overlay (a message view it was opened from sits at 9999)
      className="fixed inset-0 z-[10000] bg-black/80 flex flex-col items-center justify-center p-6 gap-3"
      onClick={onClose}
      onKeyDown={e => keepTabInside(e, dialogRef.current, document.activeElement)}
    >
      <div className="flex-1 min-h-0 w-full flex items-center justify-center" onClick={e => e.stopPropagation()}>
        {children}
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

const viewerNote = (text: string) => <div className="text-white/90 text-sm text-center max-w-md">{text}</div>;

/** A photo full size, over the window. Too big to show here: it opens in another app. */
export function Viewer({ source = 'whatsapp', udid, attachment, label, onClose }: {
  source?: MediaSource;
  udid: string;
  attachment: AttachmentProps['attachment'];
  label: string;
  onClose: () => void;
}) {
  // The thumbnail already on screen stands in while the full photo loads
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [placeholder] = useState(() => {
    const t = thumbs.get(`${fileKey(source, udid, attachment.attachment_id)}:thumb`);
    return t && 'url' in t ? t.url : null;
  });
  const opener = useOpener(udid, attachment.attachment_id, source);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useViewerKeys(onClose, closeRef);

  useEffect(() => {
    let live = true;
    loadPicture(source, udid, attachment.attachment_id, false).then(l => {
      if (!live) return;
      setLoaded(l);
      // Too big to show here: hand it to the computer's photo viewer instead
      if ('tooLarge' in l) opener.open();
    });
    return () => { live = false; };
  }, [source, udid, attachment.attachment_id]);

  const shown = loaded && 'url' in loaded ? loaded.url : !loaded ? placeholder : null;
  return viewerFrame({
    dialogRef, closeRef, label, onClose, opener,
    children: (
      <>
        {shown && <img src={shown} alt={label} className="max-w-full max-h-full object-contain rounded-lg" />}
        {!loaded && !shown && <div className="text-white/80 text-sm">Loading…</div>}
        {loaded && 'tooLarge' in loaded && viewerNote('This photo is too big to show here, so it opens in another app.')}
        {loaded && 'missing' in loaded && viewerNote(missingText('image'))}
        {loaded && 'noThumbnail' in loaded && viewerNote("This file can't be shown here. Open it in another app.")}
        {loaded && 'error' in loaded && viewerNote(`Couldn't show this photo: ${loaded.error}`)}
      </>
    ),
  });
}

type Playing = { src: string } | { missing: true } | { error: string } | { cantPlay: true };

/**
 * A video playing in the app, over the window, from a copy the engine makes.
 * When this computer can't play it (a kind of video it has no decoder for), it
 * says so and the video opens in another app from the button below.
 */
export function VideoViewer({ source = 'whatsapp', udid, attachment, label, loop = false, onClose }: {
  source?: MediaSource;
  udid: string;
  attachment: AttachmentProps['attachment'];
  label: string;
  /** A GIF plays round and round. */
  loop?: boolean;
  onClose: () => void;
}) {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const opener = useOpener(udid, attachment.attachment_id, source);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useViewerKeys(onClose, closeRef);

  useEffect(() => {
    let live = true;
    ask(source, udid, attachment.attachment_id, { as_file: true }).then(r => {
      if (!live) return;
      if (r?.empty_reason === 'not_in_backup') setPlaying({ missing: true });
      else if (r?.error) setPlaying({ error: r.error });
      else if (!r?.path) setPlaying({ error: "Couldn't copy it out of the backup" });
      else setPlaying({ src: localMediaUrl(r.path) });
    }, (e: unknown) => { if (live) setPlaying({ error: message(e) }); });
    return () => { live = false; };
  }, [source, udid, attachment.attachment_id]);

  const what = label.toLowerCase();
  return viewerFrame({
    dialogRef, closeRef, label, onClose, opener,
    children: (
      <>
        {!playing && <div className="text-white/80 text-sm">Getting the {what} ready…</div>}
        {playing && 'src' in playing && (
          <video
            src={playing.src}
            controls
            autoPlay
            playsInline
            loop={loop}
            aria-label={label}
            className="max-w-full max-h-full rounded-lg bg-black"
            onError={() => setPlaying({ cantPlay: true })}
          />
        )}
        {playing && 'cantPlay' in playing && viewerNote(`This ${what} can't play here. Open it in another app to watch it.`)}
        {playing && 'missing' in playing && viewerNote(missingText('video'))}
        {playing && 'error' in playing && viewerNote(`Couldn't play this ${what}: ${playing.error}`)}
      </>
    ),
  });
}

// ── Photos and stickers ────────────────────────────────────────────────────

function Picture({ source, udid, attachment, kind, onColour, tile }: {
  source: MediaSource; udid: string; attachment: AttachmentProps['attachment']; kind: 'image' | 'sticker'; onColour: boolean; tile: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearScreen(ref);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [viewing, setViewing] = useState(false);
  const opener = useOpener(udid, attachment.attachment_id, source);
  const sticker = kind === 'sticker';
  // The picture's space is set once, before it loads (its own shape when known, else a fixed
  // box it's cropped into), so the chat doesn't move as pictures arrive above what's on screen
  const [box] = useState(() => tile ? { width: TILE, height: TILE }
    : sticker ? { width: 128, height: 128 }
    : fitBox(attachment.width, attachment.height, 240, 256)
      ?? fitShape(shapes.get(fileKey(source, udid, attachment.attachment_id)))
      ?? UNKNOWN_SHAPE);
  const label = documentName(attachment) || kindLabel(kind);
  const small = startsSmall(source, attachment, kind);

  useEffect(() => {
    if (!near) return;
    let live = true;
    (async () => {
      let l = await loadPicture(source, udid, attachment.attachment_id, small);
      // No thumbnail after all (WhatsApp's stored one is gone, or Messages couldn't make one):
      // the picture itself, if it's small enough
      if (small && ('noThumbnail' in l || 'error' in l || (source === 'whatsapp' && 'missing' in l))) {
        l = await loadPicture(source, udid, attachment.attachment_id, false);
      }
      if (live) setLoaded(l);
    })();
    return () => { live = false; };
  }, [near, source, udid, attachment.attachment_id, small]);

  if (loaded && 'missing' in loaded) return <Missing kind={kind} attachment={attachment} onColour={onColour} tile={tile} />;

  const failed = !!loaded && !('url' in loaded);
  const tooLarge = !!loaded && 'tooLarge' in loaded;
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => (tooLarge ? opener.open() : setViewing(true))}
        title={sticker ? label : `Show the ${label === 'Photo' ? 'photo' : label} full size`}
        aria-label={sticker ? label : `${label}, show full size`}
        className={`block ${tile ? '' : 'mt-1'} rounded-lg overflow-hidden ${loaded && 'url' in loaded ? '' : onColour ? 'bg-white/15' : 'bg-black/5'}`}
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
          <span className={`w-full h-full flex flex-col items-center justify-center gap-1 text-xs px-2 ${muted(onColour)}`}>
            <ImageOff size={tile ? 16 : 20} />
            {tile ? '' : tooLarge ? 'Too big to show here: open it' : "Couldn't show it"}
          </span>
        ) : null}
      </button>
      <Status text={opener.status} onColour={onColour} tile={tile} />
      {viewing && (
        <Overlay>
          <Viewer source={source} udid={udid} attachment={attachment} label={label} onClose={() => setViewing(false)} />
        </Overlay>
      )}
    </>
  );
}

function fitShape(shape: { width: number; height: number } | undefined) {
  return shape ? fitBox(shape.width, shape.height, 240, 256) : null;
}

// ── Videos and GIFs ────────────────────────────────────────────────────────

function VideoTile({ source, udid, attachment, kind, onColour, tile }: {
  source: MediaSource; udid: string; attachment: AttachmentProps['attachment']; kind: 'video' | 'gif'; onColour: boolean; tile: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearScreen(ref);
  const [poster, setPoster] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const label = kindLabel(kind);
  const length = attachment.duration ? durationText(attachment.duration) : '';
  const stored = source === 'whatsapp' && !!attachment.thumbnail_path;
  const size = attachment.total_bytes;
  const fromCopy = !stored && (size == null || size <= POSTER_MAX_BYTES) && canMakePosters();

  // WhatsApp's own stored thumbnail
  useEffect(() => {
    if (!near || !stored) return;
    let live = true;
    loadPicture(source, udid, attachment.attachment_id, true).then(l => { if (live && 'url' in l) setPoster(l.url); });
    return () => { live = false; };
  }, [near, stored, source, udid, attachment.attachment_id]);

  // Otherwise a frame of the video itself, from a copy (macOS and Windows)
  useEffect(() => {
    if (!near || !fromCopy) return;
    const key = fileKey(source, udid, attachment.attachment_id);
    posterWanted.set(key, (posterWanted.get(key) ?? 0) + 1);
    let live = true;
    makePoster(source, udid, attachment.attachment_id).then(url => { if (live && url) setPoster(url); });
    return () => {
      live = false;
      const left = (posterWanted.get(key) ?? 1) - 1;
      if (left > 0) posterWanted.set(key, left);
      else posterWanted.delete(key);
    };
  }, [near, fromCopy, source, udid, attachment.attachment_id]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setViewing(true)}
        title={`Play the ${label.toLowerCase()}`}
        aria-label={`Play ${label.toLowerCase()}${length ? `, ${length}` : ''}`}
        className={`relative block ${tile ? '' : 'mt-1'} rounded-lg overflow-hidden ${poster ? 'bg-black' : onColour ? 'bg-white/15' : 'bg-black/5'}`}
        style={tile ? { width: TILE, height: TILE } : { width: 200, height: 150 }}
      >
        {poster && <img src={poster} alt="" className="w-full h-full object-cover block" />}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className={`${tile ? 'w-8 h-8' : 'w-11 h-11'} rounded-full bg-black/55 flex items-center justify-center`}>
            <Play size={tile ? 14 : 20} className="text-white ml-0.5" />
          </span>
        </span>
        {(!tile || length) && (
          <span className={`absolute left-1.5 bottom-1 text-xs font-medium drop-shadow ${poster ? 'text-white' : tile ? 'text-text-secondary' : onColour ? 'text-white' : 'text-text-secondary'}`}>
            {tile ? length : <>{label}{length && ` · ${length}`}</>}
          </span>
        )}
      </button>
      {viewing && (
        <Overlay>
          <VideoViewer source={source} udid={udid} attachment={attachment} label={label} loop={kind === 'gif'} onClose={() => setViewing(false)} />
        </Overlay>
      )}
    </>
  );
}

// ── Voice messages and audio ───────────────────────────────────────────────

export function Sound({ source = 'whatsapp', udid, attachment, kind, isMine, tile = false }: {
  source?: MediaSource; udid: string; attachment: AttachmentProps['attachment']; kind: 'voice' | 'audio'; isMine: boolean; tile?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'cant-play'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const opener = useOpener(udid, attachment.attachment_id, source);
  const alive = useAlive();
  const onColour = isMine && !tile;
  const label = kind === 'voice' ? 'voice message' : 'audio';
  const length = attachment.duration ? durationText(attachment.duration) : '';

  // A blob URL holds the sound in memory until it's let go
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  async function play() {
    if (!playsInApp(attachment)) { opener.open(); return; }
    setState('loading');
    setProblem(null);
    try {
      const r = await ask(source, udid, attachment.attachment_id);
      // Gone from the screen while it loaded (another chat picked): nothing would ever let a blob go
      if (!alive.current) return;
      const l = readResult(r);
      if ('tooLarge' in l) { setState('idle'); opener.open(); return; }
      if ('missing' in l) { setState('idle'); setProblem(missingText(kind)); return; }
      if ('error' in l || 'noThumbnail' in l) { setState('idle'); setProblem('error' in l ? l.error : "The file couldn't be read"); return; }
      const bin = atob(r.data!);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      setSrc(URL.createObjectURL(new Blob([bytes], { type: r.mime_type || 'audio/ogg' })));
      setState('idle');
    } catch (e) {
      if (!alive.current) return;
      setState('idle');
      setProblem(message(e));
    }
  }

  if (src && state !== 'cant-play') {
    return (
      <audio
        controls
        autoPlay
        src={src}
        aria-label={kind === 'voice' ? 'Voice message' : 'Audio'}
        className={`${tile ? '' : 'mt-1'} w-64 max-w-full`}
        onError={() => setState('cant-play')}
      />
    );
  }

  const Glyph = kind === 'voice' ? Mic : Music;
  const words = state === 'loading' ? 'Loading…' : state === 'cant-play' ? `Open the ${label} in another app` : `Play ${label}`;
  const said = state === 'cant-play' ? "This kind of sound can't play here." : problem ?? opener.status;
  if (tile) {
    return (
      <>
        <button
          type="button"
          onClick={state === 'cant-play' ? opener.open : play}
          disabled={state === 'loading'}
          title={words}
          aria-label={`${words}${length ? `, ${length}` : ''}`}
          className="flex flex-col items-center justify-center gap-1 rounded-lg bg-accent-wash hover:brightness-95 text-accent text-[11px] leading-tight"
          style={{ width: TILE, height: TILE }}
        >
          {state === 'loading' ? <Glyph size={20} /> : <Play size={20} />}
          <span className="text-text-secondary">{state === 'loading' ? 'Loading…' : length || (kind === 'voice' ? 'Voice' : 'Audio')}</span>
        </button>
        <Status text={said} onColour={false} tile />
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={state === 'cant-play' ? opener.open : play}
        disabled={state === 'loading'}
        className={`mt-1 flex items-center gap-2 text-sm rounded-full pl-1.5 pr-3 py-1 ${onColour ? 'bg-white/20 hover:bg-white/25' : 'bg-black/5 hover:bg-black/10'}`}
      >
        <span className={`w-7 h-7 rounded-full flex items-center justify-center ${onColour ? 'bg-white/25' : 'bg-accent-wash'}`}>
          {state === 'loading' ? <Glyph size={14} /> : <Play size={14} className={onColour ? 'text-white' : 'text-accent'} />}
        </span>
        <span>
          {words}
          {length && state === 'idle' && <span className={muted(onColour)}> · {length}</span>}
        </span>
      </button>
      <Status text={said} onColour={onColour} />
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
export function Document({ source = 'whatsapp', udid, attachment, isMine, tile = false }: {
  source?: MediaSource; udid: string; attachment: AttachmentProps['attachment']; isMine: boolean; tile?: boolean;
}) {
  const opener = useOpener(udid, attachment.attachment_id, source);
  const onColour = isMine && !tile;
  const name = documentName(attachment);
  const { stem, ext } = splitExtension(name || 'Document');
  const details = [name ? fileTypeLabel(name) : '', formatBytes(attachment.total_bytes)].filter(Boolean).join(' · ');
  const aria = `${name || 'Document'}${details ? `, ${details}` : ''}`;
  if (tile) {
    return (
      <>
        <button
          type="button"
          onClick={opener.open}
          title={aria}
          aria-label={aria}
          className="flex flex-col items-center justify-center gap-1 rounded-lg bg-black/5 hover:bg-black/10 px-1"
          style={{ width: TILE, height: TILE }}
        >
          <FileText size={22} className="text-accent flex-shrink-0" />
          <span className="text-[11px] leading-tight font-medium text-text-secondary max-w-full truncate">
            {ext ? ext.slice(1).toUpperCase() : 'File'}
          </span>
        </button>
        <Status text={opener.status} onColour={false} tile />
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={opener.open}
        title={name || 'Document'}
        aria-label={aria}
        className={`mt-1 w-full max-w-xs flex items-center gap-2.5 text-left rounded-xl px-2.5 py-2 ${onColour ? 'bg-white/20 hover:bg-white/25' : 'bg-black/5 hover:bg-black/10'}`}
      >
        <FileText size={22} className={`flex-shrink-0 ${onColour ? 'text-white' : 'text-accent'}`} />
        <span className="min-w-0 flex-1">
          {/* A long name is cut short before its extension, so the extension stays in view */}
          <span className="flex min-w-0 text-sm font-medium">
            <span className="truncate">{stem}</span>
            {ext && <span className="flex-shrink-0">{ext}</span>}
          </span>
          {details && <span className={`block text-xs ${muted(onColour)}`}>{details}</span>}
        </span>
      </button>
      <Status text={opener.status} onColour={onColour} />
    </>
  );
}

// ── One attachment ─────────────────────────────────────────────────────────

/**
 * One attachment, from Messages or WhatsApp, as a chat bubble shows it
 * ('bubble') or as a small square on a Timeline or People card ('tile').
 */
export default function MediaAttachment({ udid, attachment, isMine, messageType, source, size = 'bubble' }: AttachmentProps & {
  source: MediaSource;
  size?: MediaSize;
}) {
  const kind = attachmentKind(attachment, messageType, source);
  const tile = size === 'tile';
  const onColour = isMine && !tile;
  let body: ReactElement;
  // Not in the backup (never downloaded, or left out): say so, and don't ask the engine for it
  if (attachment.available === false) body = <Missing kind={kind} attachment={attachment} onColour={onColour} tile={tile} />;
  else {
    switch (kind) {
      case 'image':
      case 'sticker':
        body = <Picture source={source} udid={udid} attachment={attachment} kind={kind} onColour={onColour} tile={tile} />;
        break;
      case 'video':
      case 'gif':
        body = <VideoTile source={source} udid={udid} attachment={attachment} kind={kind} onColour={onColour} tile={tile} />;
        break;
      case 'voice':
      case 'audio':
        body = <Sound source={source} udid={udid} attachment={attachment} kind={kind} isMine={isMine} tile={tile} />;
        break;
      default:
        body = <Document source={source} udid={udid} attachment={attachment} isMine={isMine} tile={tile} />;
    }
  }
  if (!tile) return body;
  // On a card: the file's own clicks (and Enter or Space on it) are its own, not the card's.
  // Other keys go on, so Escape still reaches an open viewer.
  return (
    <span
      className="inline-flex flex-col align-top"
      onClick={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
    >
      {body}
    </span>
  );
}

/** A Messages (sms.db) attachment in a chat bubble. */
export function MessagesAttachment(props: AttachmentProps) {
  return <MediaAttachment {...props} source="messages" />;
}

/** A WhatsApp attachment in a chat bubble. */
export function WhatsAppAttachment(props: AttachmentProps) {
  return <MediaAttachment {...props} source="whatsapp" />;
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
    loadPicture('whatsapp', udid, location.attachment_id, true).then(l => {
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
