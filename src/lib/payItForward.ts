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
/** The site's business rates ($50 a case, $200 a year, with a receipt), for "Using it for paid work?". */
export const SUPPORT_BUSINESS_URL = 'https://www.openextract.app/support#business';

/**
 * The price step in the Save window ("What's this worth to you?", PriceStep.tsx): asked on
 * the first save of each run, before saving, until the person says they've paid. A test of
 * whether asking at the moment of saving gets more people to pay than the card after an
 * export, so in a run where it has asked, that card doesn't come (it's one ask a run).
 *
 * Its amounts go through their own redirects on the site (/support/pay/app/...), which send
 * people to the same Stripe links as the support page with client_reference_id=app_save_step,
 * so payments from this step can be told apart. Nothing is sent from the app: the browser
 * opens the page, and the tag is the same for everyone.
 */
export const PRICE_STEP_AMOUNTS = [
  { id: '5', label: '$5', note: '' },
  { id: '25', label: '$25', note: 'Suggested' },
  { id: '100', label: '$100', note: 'Covers others' },
  { id: 'any', label: 'Other', note: 'Any amount' },
] as const;
export type PriceStepAmount = (typeof PRICE_STEP_AMOUNTS)[number]['id'];
/** The amount picked when the step opens. */
export const PRICE_STEP_SUGGESTED: PriceStepAmount = '25';

/** The site's redirect for an amount in the price step. */
export function priceStepUrl(amount: PriceStepAmount): string {
  return `${SUPPORT_PAY_URL}/app/${amount}`;
}

/**
 * Whether a Save should show the price step first: not after "I've paid", and not again in a
 * run where an ask was already shown or dismissed. When the answer isn't known (no bridge, or
 * it failed), no: the step never stands between someone and their save.
 */
export function priceStepDue(status: { paid: boolean; snoozed?: boolean } | null | undefined): boolean {
  return !!status && !status.paid && !status.snoozed;
}

export interface SupportStatus { paid: boolean; thanksSent: boolean; snoozed?: boolean }

/** The ask's state from the main process, or null when there's no bridge or it fails. */
export function readSupportStatus(): Promise<SupportStatus | null> {
  return Promise.resolve(window.openextract?.support?.status?.()).then(s => s ?? null, () => null);
}

/** Shows the price step in its own window (PriceStepHost) and says whether to go on with the save. */
export interface PriceStepRequest { thanksSent: boolean; resolve: (goOn: boolean) => void }
let priceStepHost: ((request: PriceStepRequest) => void) | null = null;

/** PriceStepHost registers itself here; the returned function unregisters it. */
export function setPriceStepHost(host: (request: PriceStepRequest) => void): () => void {
  priceStepHost = host;
  return () => { if (priceStepHost === host) priceStepHost = null; };
}

/**
 * Before a save that doesn't go through the Save window (photos, voicemail audio, anything
 * with one format): the price step in its own window when it's due, then true to go on or
 * false when the person backs out. True straight away when it isn't due, including after the
 * Save window already asked in this run, so calling it after that window never asks twice.
 */
export async function askPriceFirst(): Promise<boolean> {
  if (!priceStepHost) return true;
  const status = await readSupportStatus();
  if (!priceStepDue(status)) return true;
  const host = priceStepHost;
  if (!host) return true;
  window.openextract?.support?.snooze?.();
  return new Promise(resolve => host({ thanksSent: status!.thanksSent, resolve }));
}

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

const THANKS_EVENT = 'openextract:say-thanks';

/** Opens the thank-you note (FeedbackProvider listens) from places that don't use its context, like the price step. */
export function openThanks(area: FeedbackArea) {
  window.dispatchEvent(new CustomEvent<FeedbackArea>(THANKS_EVENT, { detail: area }));
}

export function onOpenThanks(listener: (area: FeedbackArea) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<FeedbackArea>).detail);
  window.addEventListener(THANKS_EVENT, handler);
  return () => window.removeEventListener(THANKS_EVENT, handler);
}

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
