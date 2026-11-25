// The People list on the Photos screen: the groups the iPhone's Photos app made of the faces it
// found (its People album), named or not. Most groups are never named on the phone, so they're
// shown by face. OpenExtract only shows what Photos worked out; it never compares faces itself.

/**
 * A face to show for someone, passed as it is to get_face_thumbnail: Photos' face box on a still
 * photo in the backup; else, for someone Photos only saw from the side or behind, their body box
 * (no face box); `poster` when it's the iPhone's own thumbnail of a video they're in.
 */
export interface PhotoPersonFace {
  file_hash: string;
  center_x: number | null;
  center_y: number | null;
  size: number | null;
  body?: { center_x: number; center_y: number; width: number; height: number };
  poster?: boolean;
}

/** One person from list_photo_people. */
export interface PhotoPerson {
  id: string;
  name: string | null;
  contact_uri: string | null;
  /** Photos All Photos shows with their face on. */
  photo_count: number;
  /** How many of those the backup has: what picking them shows. */
  in_backup: number;
  not_in_backup: number;
  missing_from_folder: number;
  face: PhotoPersonFace | null;
}

/** With two or more people picked: photos with any of them, or only those with all of them together. */
export type PersonMatch = 'any' | 'all';

/** People with at least this many photos in the backup are listed before "Show more". */
export const PEOPLE_SHOWN_FROM = 3;
/** And at least this many people are, when the backup has them. */
export const PEOPLE_SHOWN_AT_LEAST = 5;

/** What someone is called in the list: their name in Photos, else "Unnamed person". */
export function personLabel(person: Pick<PhotoPerson, 'name'>): string {
  return person.name?.trim() || 'Unnamed person';
}

function photos(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'photo' : 'photos'}`;
}

/** Someone's row, said in full (for screen readers and the tooltip): "Unnamed person, 58 photos". */
export function personDescription(person: Pick<PhotoPerson, 'name' | 'in_backup'>): string {
  return `${personLabel(person)}, ${photos(person.in_backup)}`;
}

/**
 * The people listed before "Show more", in the engine's order (most photos first): everyone with
 * PEOPLE_SHOWN_FROM photos or more in the backup, and at least the first PEOPLE_SHOWN_AT_LEAST with
 * any. Someone with no photo in the backup only comes with the rest. Anyone picked stays listed.
 */
export function peopleShown(people: PhotoPerson[], showAll: boolean, picked: string[] = []): PhotoPerson[] {
  if (showAll) return people;
  const withPhotos = people.filter(p => p.in_backup > 0);
  const many = withPhotos.filter(p => p.in_backup >= PEOPLE_SHOWN_FROM);
  const shown = new Set((many.length >= PEOPLE_SHOWN_AT_LEAST ? many : withPhotos.slice(0, PEOPLE_SHOWN_AT_LEAST)).map(p => p.id));
  return people.filter(p => shown.has(p.id) || picked.includes(p.id));
}

/** The "Show more" button under the list: "Show 236 more people". */
export function showMorePeople(hidden: number): string {
  return `Show ${hidden.toLocaleString()} more ${hidden === 1 ? 'person' : 'people'}`;
}

/** Before the chips above the grid: "Photos of" one person, "Photos with any of" or "with all of" several. */
export function peopleShowing(count: number, match: PersonMatch): string {
  if (count === 1) return 'Photos of';
  return match === 'all' ? 'Photos with all of' : 'Photos with any of';
}

/** The save button's label while people are picked. */
export const SAVE_PEOPLE = 'Save their photos';

/** What the "saved" message is titled for the people picked. */
export function peopleSavedTitle(picked: Pick<PhotoPerson, 'name'>[], match: PersonMatch): string {
  if (picked.length === 1) {
    const name = picked[0].name?.trim();
    return name ? `Saved photos of ${name}` : 'Saved photos of an unnamed person';
  }
  return match === 'all' && picked.length > 1
    ? `Saved photos of ${picked.length} people together`
    : `Saved photos of ${picked.length} people`;
}

/** The people picked, as the engine takes them (empty for none). */
export function togglePerson(picked: string[], id: string): string[] {
  return picked.includes(id) ? picked.filter(p => p !== id) : [...picked, id];
}
