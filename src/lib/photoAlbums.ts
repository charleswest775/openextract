// The Photos sidebar (#215): All Photos, Favorites and Hidden first, then the backup's
// albums as the phone files them (albums inside folders, folders inside folders), then
// shared albums. The engine's list_albums sends them in that order, each album with the
// id of the folder it's in (parent_id). An engine from before then sends a flat list
// with no Favorites, Hidden or folders, which shows as before.

export interface PhotoAlbum {
  id: string;
  title: string;
  asset_count: number;
  /** How many of its photos the backup has a file for (the rest are only in iCloud). */
  in_backup?: number;
  /** 'smart', 'user', 'shared' or 'folder'. */
  kind?: string;
  /** The folder it's in; null or missing at the top level. */
  parent_id?: string | null;
}

export const ALL_PHOTOS = '__all__';
export const FAVORITES = '__favorites__';
export const HIDDEN = '__hidden__';

export interface AlbumNode {
  album: PhotoAlbum;
  /** What's inside a folder, in the phone's order; empty for an album. */
  children: AlbumNode[];
}

export interface PhotoSidebar {
  /** The engine's All Photos entry, for its count. */
  allPhotos?: PhotoAlbum;
  /** Favorites and Hidden, when the library records them. */
  smart: PhotoAlbum[];
  /** Albums and folders at the top level. */
  albums: AlbumNode[];
  shared: PhotoAlbum[];
}

/** How many photos to show next to an album: the ones the backup has. */
export function albumCount(album: PhotoAlbum): number {
  return album.in_backup ?? album.asset_count;
}

export function isFolder(album: PhotoAlbum): boolean {
  return album.kind === 'folder';
}

export function photoSidebar(list: PhotoAlbum[]): PhotoSidebar {
  const allPhotos = list.find(a => a.id === ALL_PHOTOS);
  const smart = list.filter(a => a.id === FAVORITES || a.id === HIDDEN);
  // The sidebar draws its own All Photos, so an album of that name would be a second one.
  const rest = list.filter(a =>
    a.id !== ALL_PHOTOS && a.id !== FAVORITES && a.id !== HIDDEN && a.title.trim().toLowerCase() !== 'all photos');
  const shared = rest.filter(a => a.kind === 'shared');
  const mine = rest.filter(a => a.kind !== 'shared');

  const parentOf = new Map(mine.map(a => [a.id, a.parent_id ?? null]));
  // Only a damaged library has a folder inside itself; its albums still show, at the top.
  const inLoop = (id: string) => {
    const seen = new Set<string>();
    for (let p = parentOf.get(id) ?? null; p !== null; p = parentOf.get(p) ?? null) {
      if (p === id) return true;
      if (seen.has(p)) return false;
      seen.add(p);
    }
    return false;
  };

  const nodes = new Map<string, AlbumNode>(mine.map(a => [a.id, { album: a, children: [] }]));
  const albums: AlbumNode[] = [];
  for (const a of mine) {
    const node = nodes.get(a.id)!;
    const parent = a.parent_id ? nodes.get(a.parent_id) : undefined;
    if (parent && !inLoop(a.id)) parent.children.push(node);
    else albums.push(node);
  }
  return { allPhotos, smart, albums, shared };
}

/** Whether the sidebar is worth showing: an album, or Favorites or Hidden with photos in them. */
export function hasSidebar(sidebar: PhotoSidebar): boolean {
  return sidebar.albums.length > 0 || sidebar.shared.length > 0 || sidebar.smart.some(a => albumCount(a) > 0);
}

/**
 * The save button's label for the album on screen (null is All Photos): for the photos
 * picked when there are any, or "Save these" when the dates or a kind narrow the grid.
 */
export function saveLabel(selected: string | null, picked = 0, narrowed = false): string {
  if (picked > 0) return `Save ${picked.toLocaleString()} selected`;
  if (narrowed) return 'Save these';
  if (selected === null || selected === ALL_PHOTOS) return 'Save all';
  if (selected === FAVORITES) return 'Save favorites';
  if (selected === HIDDEN) return 'Save hidden';
  return 'Save album';
}

/** What the "saved" message is titled. */
export function savedTitle(selected: string | null, albums: PhotoAlbum[]): string {
  const title = albumTitle(selected, albums);
  return title === null ? 'Saved photos and videos' : `Saved ${title}`;
}

/** The title of the album on screen, or null for All Photos. */
export function albumTitle(selected: string | null, albums: PhotoAlbum[]): string | null {
  const album = selected === null ? undefined : albums.find(a => a.id === selected);
  return !album || album.id === ALL_PHOTOS ? null : album.title;
}
