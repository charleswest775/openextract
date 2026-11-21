import type { FeedbackArea } from './feedback';

/**
 * "Pay it forward": the app's ask for $5 from people OpenExtract helped.
 *
 * The card (components/shared/PayItForwardPrompt.tsx) shows after exports, when the
 * main process says so (electron/main.ts, increment-export-count), and whenever the
 * header's "Pay it forward" button is clicked. Nothing here talks to the network:
 * "Pay $5" opens the site's /support/pay redirect in the user's browser, which
 * holds the payment link, so the payment service can change without a release.
 */

/** Goes straight to the payment page (vercel.json redirects it to Stripe). */
export const SUPPORT_PAY_URL = 'https://www.openextract.app/support/pay';
/** The site's amounts: $0 if money's tight, $5, $25, $100, and rates for paid work. */
export const SUPPORT_AMOUNTS_URL = 'https://www.openextract.app/support#pay';

/** Which wording the card uses. */
export type AskMode =
  /** First export ever (or the first since this card replaced the thank-you card): Charles introduces himself. */
  | 'intro'
  /** Any later export: a shorter ask, signed. */
  | 'repeat'
  /** "Looks right" on the "Did that come out right?" card. */
  | 'checked'
  /** The header button or Settings: not tied to an export. */
  | 'header';

export interface AskRequest {
  mode: AskMode;
  area?: FeedbackArea;
  /** 'opened' when the payment page was already opened from somewhere else (the thank-you screen). */
  stage?: 'ask' | 'opened';
}

const ASK_EVENT = 'openextract:pay-it-forward';
const EXPORTED_EVENT = 'openextract:exported';

/** Shows the card from anywhere in the window. */
export function showAsk(request: AskRequest) {
  window.dispatchEvent(new CustomEvent<AskRequest>(ASK_EVENT, { detail: request }));
}

export function onAsk(listener: (request: AskRequest) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<AskRequest>).detail);
  window.addEventListener(ASK_EVENT, handler);
  return () => window.removeEventListener(ASK_EVENT, handler);
}

/** Every successful export, so the header button can glow once. */
export function announceExport() {
  window.dispatchEvent(new Event(EXPORTED_EVENT));
}

export function onExport(listener: () => void): () => void {
  window.addEventListener(EXPORTED_EVENT, listener);
  return () => window.removeEventListener(EXPORTED_EVENT, listener);
}

/** What the person just saved, in their words: "Your photos are saved", "getting your photos off your iPhone". */
export function whatWasSaved(area?: FeedbackArea): { noun: string; plural: boolean } {
  switch (area) {
    case 'messages': return { noun: 'messages', plural: true };
    case 'record_recovery': return { noun: 'deleted messages', plural: true };
    case 'whatsapp': return { noun: 'WhatsApp chats', plural: true };
    case 'photos': return { noun: 'photos', plural: true };
    case 'contacts': return { noun: 'contacts', plural: true };
    case 'calls': return { noun: 'call history', plural: false };
    case 'notes': return { noun: 'notes', plural: true };
    case 'voicemail': return { noun: 'voicemails', plural: true };
    case 'podcasts': return { noun: 'podcasts', plural: true };
    case 'voice_memos': return { noun: 'voice memos', plural: true };
    case 'calendar': return { noun: 'calendar', plural: false };
    case 'browser_history': return { noun: 'web history', plural: false };
    default: return { noun: 'data', plural: false };
  }
}
