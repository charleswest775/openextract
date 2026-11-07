// What a message with no text and no attachment says in the thread view.
// Exports use the same words (_EVENT_LABELS and _event_label in
// python/messages.py).
//
// The engine says what happened in event_text for a group change, an unsent
// message or a FaceTime call ("Karin added Theo to the conversation"). Other
// such messages get a label by message_type. Anything else is a
// "Conversation update": the engine calls rows it can't name "system" (and
// some "location"), so a more specific label wouldn't be true.
export const EVENT_LABELS: Record<string, string> = {
  location_started_by_me: 'You started sharing your location',
  location_stopped_by_me: 'You stopped sharing your location',
  location_started_by_them: 'Started sharing their location',
  location_stopped_by_them: 'Stopped sharing their location',
  audio: 'Audio message not in this backup',
  attachment: 'Attachment',
  link: 'Link',
  payment: 'Apple Pay payment',
  digital_touch: 'Digital Touch message',
  handwriting: 'Handwritten message',
  fitness: 'Fitness activity',
  game: 'Game message',
  app: 'Message from an iMessage app',
};
export const EVENT_FALLBACK = 'Conversation update';

/** The words for a message with no text and no attachment, without brackets. */
export function eventLabel(message: { message_type?: string; event_text?: string | null }): string {
  if (message.event_text) return message.event_text;
  const type = message.message_type ?? '';
  return Object.prototype.hasOwnProperty.call(EVENT_LABELS, type) ? EVENT_LABELS[type] : EVENT_FALLBACK;
}
