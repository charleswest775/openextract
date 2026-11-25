import { useState, useEffect, useCallback, useRef } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { CameraIcon, ChevronRightIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import {
  moreMissingFromFolder, moreOnlyInIcloud, noPhotosHere, photoExportSummary, photoSaveFailures, photoSaveProgress,
  PhotoExportResult, VIDEO_GETTING_READY, videoProblem,
} from '../../lib/photoCounts';
import { CopiedFile, handOver } from '../../lib/openFile';
import { useNotice } from '../shared/Notices';
import { percentDone } from '../../lib/exportProgress';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import { SaveButton, SaveProgress } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { useExportProgress } from '../../hooks/useExportProgress';
import { checkEngineResult, plural } from '../../lib/saveData';
import { TimelinePhotoLightbox } from '../timeline/TimelineEntryCard';
import type { TimelineEntry } from '../../types/timeline';
import {
  albumCount, AlbumNode, hasSidebar, isFolder, PhotoAlbum, photoSidebar, saveLabel, savedTitle,
} from '../../lib/photoAlbums';
import {
  PersonMatch, PhotoPerson, PhotoPersonFace, peopleSavedTitle, peopleShowing, peopleShown, personDescription,
  personLabel, SAVE_PEOPLE, showMorePeople, togglePerson,
} from '../../lib/photoPeople';

interface PhotoAsset {
  uuid: string;
  filename: string;
  file_hash: string;
  kind: string;
  date_created: string | null;
  width: number;
  height: number;
  duration: number;
  favorite: boolean;
}

// total counts rows in the Photos library (paging steps through it); in_backup
// is how many photos the pages hold, not_in_backup the rows left out because
// the backup has no file for them (only in iCloud), missing_from_folder the rows
// left out because the backup lists their file but its folder doesn't have it (OE-102).
interface PhotoPage {
  photos: PhotoAsset[];
  total: number;
  in_backup?: number;
  not_in_backup?: number;
  missing_from_folder?: number;
}

const BATCH_SIZE = 100;
const THUMB_CONCURRENCY = 6;

// Module-level cache: stores base64 data for successful thumbs.
// Failed hashes are tracked separately so they can be retried on remount.
const thumbnailDataCache = new Map<string, string>();
const thumbnailFailedSet = new Set<string>();

// Track in-flight requests so we don't double-request
const thumbnailInflight = new Set<string>();

// Face thumbnails for the People list, by face (photo and box), like the photo thumbnails above.
const faceDataCache = new Map<string, string>();
const faceKey = (face: PhotoPersonFace) => `${face.file_hash}:${face.center_x}:${face.center_y}:${face.size}`;
const FACE_PX = 64; // drawn at 28 px; twice that and more for sharp screens

interface Props {
  udid: string;
  /** A photo a search found: shown full size over the grid. */
  open?: TimelineEntry;
}

export default function PhotoExplorer({ udid, open }: Props) {
  const [viewing, setViewing] = useState<{ fileHash: string; filename: string } | null>(
    open?.photo ? { fileHash: open.photo.fileHash, filename: open.photo.filename } : null,
  );
  const [photos, setPhotos] = useState<PhotoAsset[]>([]);
  const [albums, setAlbums] = useState<PhotoAlbum[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(new Set());
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  // Folders open in the sidebar; they start closed, as on the phone.
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [total, setTotal] = useState(0);
  const [inBackup, setInBackup] = useState<number | null>(null);
  const [notInBackup, setNotInBackup] = useState(0);
  const [missingFromFolder, setMissingFromFolder] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string>('all');
  // The People list: the groups the iPhone's Photos app made of faces. Picking anyone
  // filters All Photos to them (and clears the album); picking an album clears them.
  const [people, setPeople] = useState<PhotoPerson[]>([]);
  const [pickedPeople, setPickedPeople] = useState<string[]>([]);
  const [personMatch, setPersonMatch] = useState<PersonMatch>('any');
  const [showAllPeople, setShowAllPeople] = useState(false);
  const [faces, setFaces] = useState<Record<string, string>>({});
  const { busy, run } = useSaveAction('photos');
  const saving = useExportProgress('photos', busy);
  const [videoLoading, setVideoLoading] = useState(false);
  const notify = useNotice();

  const offsetRef = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
  // Bumped by every load, so a load still running when the album changes drops its results.
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    // Another backup's albums and people have other ids: start again from All Photos.
    setSelectedAlbum(null);
    setPickedPeople([]);
    setPersonMatch('any');
    setShowAllPeople(false);
    setPeople([]);
    setFaces({});
    setOpenFolders(new Set());
    loadAlbums();
    loadPeople();
    loadPhotos(0);
    return () => { mountedRef.current = false; };
  }, [udid]);

  async function loadAlbums() {
    try {
      const result = await sidecarCall<{ albums: PhotoAlbum[] }>('list_albums', { udid });
      if (mountedRef.current) setAlbums(result.albums);
    } catch {
      // Non-critical
    }
  }

  async function loadPeople() {
    try {
      const result = await sidecarCall<{ people?: PhotoPerson[] }>('list_photo_people', { udid });
      if (mountedRef.current) setPeople(result.people ?? []);
    } catch {
      // Non-critical: an engine without People, or a library it couldn't read, lists no one.
    }
  }

  async function loadPhotos(offset: number, albumId?: string | null, personIds: string[] = [], match: PersonMatch = 'any') {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const request = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      // offset and total count rows in the Photos library, not photos returned:
      // the engine leaves out assets it can't show (Shared Album items, files
      // not in the backup), so a page can come back short or even empty with
      // more photos after it. Step by the page size and skip empty pages.
      let next = offset;
      let result: PhotoPage;
      do {
        result = await sidecarCall<PhotoPage>(
          'list_photos',
          {
            udid, offset: next, limit: BATCH_SIZE, album_id: albumId ?? undefined,
            ...(personIds.length > 0 ? { person_ids: personIds, person_match: match } : {}),
          }
        );
        if (!mountedRef.current || request !== requestRef.current) return;
        next += BATCH_SIZE;
      } while (result.photos.length === 0 && next < result.total);

      if (offset === 0) {
        setPhotos(result.photos);
      } else {
        setPhotos(prev => [...prev, ...result.photos]);
      }
      setInBackup(result.in_backup ?? null);
      setNotInBackup(result.not_in_backup ?? 0);
      setMissingFromFolder(result.missing_from_folder ?? 0);
      setTotal(result.total);
      offsetRef.current = next;
      setHasMore(next < result.total);

      // Hydrate state from module-level cache for photos we already have
      const cachedThumbs: Record<string, string> = {};
      const needFetch: string[] = [];

      for (const photo of result.photos) {
        const h = photo.file_hash;
        if (thumbnailDataCache.has(h)) {
          cachedThumbs[h] = thumbnailDataCache.get(h)!;
        } else if (!thumbnailFailedSet.has(h) && !thumbnailInflight.has(h)) {
          needFetch.push(h);
        }
      }

      // Batch-set cached thumbnails into state
      if (Object.keys(cachedThumbs).length > 0) {
        setThumbnails(prev => ({ ...prev, ...cachedThumbs }));
      }

      // Fetch missing thumbnails
      if (needFetch.length > 0) {
        loadThumbnailBatch(needFetch);
      }
    } catch (err: any) {
      // Stop paging: retrying on every render would hammer a failing engine.
      if (mountedRef.current && request === requestRef.current) {
        setHasMore(false);
        setLoadError(err?.message || 'Unknown error');
      }
    } finally {
      if (request === requestRef.current) {
        setLoading(false);
        loadingRef.current = false;
      }
    }
  }

  async function loadThumbnailBatch(hashes: string[]) {
    for (let i = 0; i < hashes.length; i += THUMB_CONCURRENCY) {
      if (!mountedRef.current) return;
      const batch = hashes.slice(i, i + THUMB_CONCURRENCY);
      await Promise.all(batch.map(h => loadThumbnail(h)));
    }
  }

  async function loadThumbnail(fileHash: string) {
    // Already have data or already in-flight
    if (thumbnailDataCache.has(fileHash) || thumbnailInflight.has(fileHash)) {
      return;
    }

    thumbnailInflight.add(fileHash);

    try {
      const result = await sidecarCall<{ data: string; error?: string }>(
        'get_photo_thumbnail', { udid, file_hash: fileHash, size: 200 }
      );

      thumbnailInflight.delete(fileHash);

      if (result.data && !result.error) {
        // Cap cache at 500 entries (FIFO eviction)
        if (thumbnailDataCache.size >= 500) {
          const firstKey = thumbnailDataCache.keys().next().value;
          if (firstKey) thumbnailDataCache.delete(firstKey);
        }
        thumbnailDataCache.set(fileHash, result.data);
        if (mountedRef.current) {
          setThumbnails(prev => ({ ...prev, [fileHash]: result.data }));
        }
      } else {
        thumbnailFailedSet.add(fileHash);
        if (mountedRef.current) {
          setFailedThumbs(prev => new Set(prev).add(fileHash));
        }
      }
    } catch {
      thumbnailInflight.delete(fileHash);
      thumbnailFailedSet.add(fileHash);
      if (mountedRef.current) {
        setFailedThumbs(prev => new Set(prev).add(fileHash));
      }
    }
  }

  // Show a new selection from its first page: an album (null is All Photos), or people in All Photos.
  function showSelection(albumId: string | null, personIds: string[], match: PersonMatch) {
    setSelectedAlbum(albumId);
    setPickedPeople(personIds);
    setPersonMatch(match);
    setPhotos([]);
    setThumbnails({});
    setFailedThumbs(new Set());
    offsetRef.current = 0;
    loadingRef.current = false;
    loadPhotos(0, albumId, personIds, match);
  }

  const handleAlbumSelect = useCallback((albumId: string | null) => {
    showSelection(albumId, [], 'any');
  }, [udid]);

  function handlePersonToggle(id: string) {
    showSelection(null, togglePerson(pickedPeople, id), personMatch);
  }

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400 && hasMore && !loadingRef.current) {
      loadPhotos(offsetRef.current, selectedAlbum, pickedPeople, personMatch);
    }
  }, [hasMore, selectedAlbum, pickedPeople, personMatch]);

  function handleSave() {
    run(async () => {
      const outputDir = await saveFolder();
      if (!outputDir) return null;
      const result = checkEngineResult(await sidecarCall<PhotoExportResult>('export_photos', {
        udid,
        output_dir: outputDir,
        options: {
          include_videos: true,
          include_live_photo_videos: false,
          format: 'original',
          jpeg_quality: 90,
          folder_structure: 'by_date',
          export_originals_if_edited: true,
          include_metadata_sidecar: false,
          // The album, Favorites or Hidden on screen; nothing for All Photos.
          album_id: selectedAlbum ?? undefined,
          // The people picked, as on screen.
          ...(pickedPeople.length > 0 ? { person_ids: pickedPeople, person_match: personMatch } : {}),
        },
      }));
      const title = pickedPeople.length > 0
        ? peopleSavedTitle(pickedPeople.map(id => people.find(p => p.id === id) ?? { name: null }), personMatch)
        : savedTitle(selectedAlbum, albums);
      return { title, detail: photoExportSummary(result), path: outputDir };
    });
  }

  async function handlePhotoClick(photo: PhotoAsset) {
    const isVideo = photo.kind === 'video' || photo.duration > 0;
    if (!isVideo) {
      setViewing({ fileHash: photo.file_hash, filename: photo.filename });
      return;
    }

    setVideoLoading(true);
    try {
      // The computer's own video player opens it (it handles HEVC, MOV, etc.). The engine
      // hands over a copy named as on the iPhone ("IMG_0042.MOV"), never the backup's own
      // file: that one has no file type in its name, so the computer couldn't tell it was
      // a video, and from some drives macOS ran it in Terminal instead (#297).
      const result = await sidecarCall<CopiedFile>('get_photo_path', { udid, file_hash: photo.file_hash });
      // Whatever goes wrong is said. Nothing happened before when the video's file
      // wasn't there (OE-102) or when the computer couldn't open it.
      const problem = await handOver(result, window.openextract);
      if (problem) {
        notify({ kind: 'error', title: "This video couldn't be opened", detail: videoProblem(problem), area: 'photos' });
      }
    } catch (err: any) {
      notify({ kind: 'error', title: "This video couldn't be opened", detail: videoProblem(err?.message), area: 'photos' });
    } finally {
      setVideoLoading(false);
    }
  }

  // What the header counts: photos the backup has, falling back to library
  // rows for an engine that doesn't report in_backup.
  const shownCount = inBackup ?? total;

  const sidebar = photoSidebar(albums);
  const showingAll = selectedAlbum === null && pickedPeople.length === 0;
  // All Photos counts what the grid shows while it's open (the DCIM scan, when Photos.sqlite
  // lists nothing), else the engine's count, so it doesn't change with the album picked.
  const allPhotosCount = showingAll ? shownCount : sidebar.allPhotos && albumCount(sidebar.allPhotos);
  const listedPeople = peopleShown(people, showAllPeople, pickedPeople);
  const morePeople = people.length - listedPeople.length;
  const picked = pickedPeople.map(id => people.find(p => p.id === id)).filter((p): p is PhotoPerson => !!p);

  // Face thumbnails for the people listed, a few at a time.
  useEffect(() => {
    let cancelled = false;
    const wanted = listedPeople.filter(p => p.face && !faces[p.id]);
    (async () => {
      for (let i = 0; i < wanted.length; i += 4) {
        const found: Record<string, string> = {};
        await Promise.all(wanted.slice(i, i + 4).map(async person => {
          const face = person.face!;
          const key = faceKey(face);
          let data = faceDataCache.get(key);
          if (!data) {
            try {
              const result = await sidecarCall<{ data?: string; error?: string }>(
                'get_face_thumbnail', { udid, ...face, px: FACE_PX });
              if (result.data && !result.error) {
                data = result.data;
                if (faceDataCache.size >= 500) faceDataCache.delete(faceDataCache.keys().next().value!);
                faceDataCache.set(key, data);
              }
            } catch {
              // The row keeps its plain circle.
            }
          }
          if (data) found[person.id] = data;
        }));
        if (cancelled || !mountedRef.current) return;
        if (Object.keys(found).length > 0) setFaces(prev => ({ ...prev, ...found }));
      }
    })();
    return () => { cancelled = true; };
  }, [udid, people, showAllPeople]);

  function toggleFolder(id: string) {
    setOpenFolders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function sidebarItem(album: PhotoAlbum, depth = 0) {
    return (
      <SidebarButton
        key={album.id}
        title={album.title}
        count={albumCount(album)}
        depth={depth}
        selected={selectedAlbum === album.id}
        onClick={() => handleAlbumSelect(album.id)}
      />
    );
  }

  function albumTree(nodes: AlbumNode[], depth: number): JSX.Element[] {
    return nodes.flatMap(({ album, children }) => {
      if (!isFolder(album)) return [sidebarItem(album, depth)];
      const open = openFolders.has(album.id);
      return [
        <button
          key={album.id}
          onClick={() => toggleFolder(album.id)}
          aria-expanded={open}
          title={album.title}
          className="w-full py-2 pr-3 rounded-lg text-left text-sm flex items-center gap-1 hover:bg-surface"
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          <ChevronRightIcon size={14} className={`flex-shrink-0 text-text-tertiary transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="truncate">{album.title}</span>
        </button>,
        ...(open ? albumTree(children, depth + 1) : []),
      ];
    });
  }

  const filteredPhotos = photos.filter(p => {
    if (kindFilter !== 'all' && p.kind !== kindFilter) return false;
    return true;
  });

  // A short page (or a filter that hides most of it) can leave the grid too
  // short to scroll, and then no scroll event comes to load the next page.
  useEffect(() => {
    const el = gridRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
      loadPhotos(offsetRef.current, selectedAlbum, pickedPeople, personMatch);
    }
  }, [filteredPhotos.length, loading, hasMore, selectedAlbum, pickedPeople, personMatch]);

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Photos"
        count={total > 0 ? `${plural(shownCount, 'photo or video', 'photos and videos')} in this backup` : undefined}
        actions={
          <>
            <select
              aria-label="Show"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="h-10 text-sm bg-surface border border-rule rounded-full px-4"
            >
              <option value="all">All types</option>
              <option value="photo">Photos</option>
              <option value="video">Videos</option>
              <option value="live_photo">Live Photos</option>
              <option value="screenshot">Screenshots</option>
            </select>
            <SaveButton
              onClick={handleSave}
              busy={busy}
              disabled={shownCount === 0}
              label={pickedPeople.length > 0 ? SAVE_PEOPLE : saveLabel(selectedAlbum)}
            />
          </>
        }
      />
      {saving && (
        <SaveProgress
          className="px-6 py-2.5 border-b border-rule"
          text={photoSaveProgress(saving.done, saving.total)}
          failures={photoSaveFailures(saving.failed)}
          percent={percentDone(saving)}
        />
      )}
      {missingFromFolder > 0 && shownCount > 0 && (
        <p className="px-6 py-2 text-sm text-text-secondary border-b border-rule">{moreMissingFromFolder(missingFromFolder)}</p>
      )}
      {notInBackup > 0 && shownCount > 0 && (
        <p className="px-6 py-2 text-sm text-text-secondary border-b border-rule">{moreOnlyInIcloud(notInBackup)}</p>
      )}
      {picked.length > 0 && (
        <div role="group" aria-label="People picked" className="px-6 py-2 border-b border-rule flex items-center gap-2 flex-wrap text-sm">
          <span className="text-text-secondary">{peopleShowing(picked.length, personMatch)}</span>
          {picked.map(person => (
            <span key={person.id} className="inline-flex items-center gap-1.5 pl-1 pr-1 py-0.5 rounded-full bg-accent-wash">
              <FaceCircle data={faces[person.id]} size={20} />
              <span className="max-w-[160px] truncate">{personLabel(person)}</span>
              <button
                onClick={() => handlePersonToggle(person.id)}
                aria-label={`Remove ${personLabel(person)}`}
                className="w-5 h-5 rounded-full flex items-center justify-center text-text-tertiary hover:bg-surface"
              >
                ×
              </button>
            </span>
          ))}
          {picked.length > 1 && (
            <span role="group" aria-label="Which photos" className="inline-flex rounded-full border border-rule overflow-hidden">
              {(['any', 'all'] as const).map(match => (
                <button
                  key={match}
                  onClick={() => showSelection(null, pickedPeople, match)}
                  aria-pressed={personMatch === match}
                  className={`px-3 py-0.5 ${personMatch === match ? 'bg-accent-wash font-medium' : 'hover:bg-surface'}`}
                >
                  {match === 'any' ? 'Any of them' : 'All together'}
                </button>
              ))}
            </span>
          )}
          <button onClick={() => handleAlbumSelect(null)} className="ml-auto text-accent hover:underline">Clear</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Album sidebar */}
        {(hasSidebar(sidebar) || people.length > 0) && (
          <nav aria-label="Albums" className="w-[240px] flex-shrink-0 border-r border-rule overflow-y-auto py-2 px-2">
            <SidebarButton
              title="All Photos"
              count={allPhotosCount || undefined}
              selected={showingAll}
              onClick={() => handleAlbumSelect(null)}
            />
            {sidebar.smart.map(album => sidebarItem(album))}
            {sidebar.albums.length > 0 && <SidebarHeading>Albums</SidebarHeading>}
            {albumTree(sidebar.albums, 0)}
            {sidebar.shared.length > 0 && <SidebarHeading>Shared albums</SidebarHeading>}
            {sidebar.shared.map(album => sidebarItem(album))}
            {people.length > 0 && (
              <>
                {/* The groups the iPhone's Photos app made of the faces it found; most are never named. */}
                <SidebarHeading>People</SidebarHeading>
                {listedPeople.map(person => (
                  <PersonButton
                    key={person.id}
                    person={person}
                    face={faces[person.id]}
                    picked={pickedPeople.includes(person.id)}
                    onClick={() => handlePersonToggle(person.id)}
                  />
                ))}
                {morePeople > 0 && (
                  <button
                    onClick={() => setShowAllPeople(true)}
                    className="w-full py-2 px-3 rounded-lg text-left text-sm text-accent hover:bg-surface"
                  >
                    {showMorePeople(morePeople)}
                  </button>
                )}
              </>
            )}
          </nav>
        )}

        {/* Photo grid */}
        <div ref={gridRef} className="flex-1 overflow-y-auto p-4" onScroll={handleScroll}>
          <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {filteredPhotos.map((photo) => {
              const thumb = thumbnails[photo.file_hash];
              const failed = failedThumbs.has(photo.file_hash);
              const isVideo = photo.kind === 'video' || photo.duration > 0;

              return (
                <div
                  key={photo.file_hash}
                  className="aspect-square bg-gray-100 rounded overflow-hidden relative group cursor-pointer"
                  onClick={() => handlePhotoClick(photo)}
                >
                  {thumb ? (
                    <img
                      src={`data:image/jpeg;base64,${thumb}`}
                      alt={photo.filename}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : isVideo ? (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-gray-800 text-text-tertiary">
                      {/* Play triangle icon */}
                      <svg className="w-10 h-10 mb-1 text-text-tertiary group-hover:text-white transition-colors" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      <span className="text-xs text-gray-500">{photo.filename.length > 16 ? photo.filename.slice(0, 14) + '...' : photo.filename}</span>
                    </div>
                  ) : failed ? (
                    <div className="w-full h-full flex flex-col items-center justify-center text-text-tertiary">
                      <svg className="w-8 h-8 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                      </svg>
                      <span className="text-xs">{photo.filename.length > 16 ? photo.filename.slice(0, 14) + '...' : photo.filename}</span>
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                    </div>
                  )}
                  {photo.duration > 0 && (
                    <div className="absolute bottom-1 right-1 bg-black/60 text-white text-xs px-1 rounded">
                      {Math.floor(photo.duration / 60)}:{String(Math.floor(photo.duration % 60)).padStart(2, '0')}
                    </div>
                  )}
                  {photo.favorite && (
                    <div className="absolute top-1 right-1 text-yellow-400 text-xs">&#9733;</div>
                  )}
                </div>
              );
            })}
          </div>
          {loading && (
            <div className="flex justify-center py-8 text-accent">
              <OrganicLoader size={56} />
            </div>
          )}
          {loadError && (
            <div className="text-center py-8 text-sm text-text-secondary">Couldn't load more photos: {loadError}</div>
          )}
          {!loading && !loadError && !hasMore && filteredPhotos.length === 0 && (
            <EmptyState
              icon={CameraIcon}
              title={kindFilter !== 'all' ? 'None of this type here' : 'No photos in this backup'}
              detail={shownCount === 0 ? noPhotosHere(missingFromFolder, notInBackup) : undefined}
            />
          )}
        </div>
      </div>

      {viewing && (
        <TimelinePhotoLightbox
          fileHash={viewing.fileHash}
          udid={udid}
          filename={viewing.filename}
          onClose={() => setViewing(null)}
        />
      )}

      {/* Video loading overlay: the video is copied out of the backup first, which takes a while for a long one */}
      {videoLoading && (
        <div className="fixed inset-0 bg-black/40 flex flex-col items-center justify-center gap-3 z-50 pointer-events-none">
          <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
          <div className="text-white/90 text-sm">{VIDEO_GETTING_READY}</div>
        </div>
      )}
    </div>
  );
}

interface PersonButtonProps {
  person: PhotoPerson;
  face?: string;
  picked: boolean;
  onClick: () => void;
}

/** A row of the People list: the face, the name or "Unnamed person", and the photos in the backup. Picking toggles. */
function PersonButton({ person, face, picked, onClick }: PersonButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={picked}
      aria-label={personDescription(person)}
      title={personDescription(person)}
      className={`w-full py-1.5 pl-2 pr-3 rounded-lg text-left text-sm flex items-center gap-2 ${
        picked ? 'bg-accent-wash font-medium' : 'hover:bg-surface'
      }`}
    >
      <FaceCircle data={face} size={28} />
      <span className={`truncate flex-1 ${person.name ? '' : 'text-text-secondary'}`}>{personLabel(person)}</span>
      <span className="text-xs text-text-tertiary flex-shrink-0 ml-1">{person.in_backup.toLocaleString()}</span>
    </button>
  );
}

/** A face thumbnail in a circle, or an empty circle while it loads (or when there's no face to show). */
function FaceCircle({ data, size }: { data?: string; size: number }) {
  return data ? (
    <img src={`data:image/jpeg;base64,${data}`} alt="" className="rounded-full object-cover flex-shrink-0" style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden="true" className="rounded-full bg-surface border border-rule flex-shrink-0" style={{ width: size, height: size }} />
  );
}

function SidebarHeading({ children }: { children: string }) {
  return <h3 className="px-3 pt-4 pb-1 text-xs uppercase tracking-wide text-text-tertiary font-medium">{children}</h3>;
}

interface SidebarButtonProps {
  title: string;
  count?: number;
  depth?: number;
  selected: boolean;
  onClick: () => void;
}

function SidebarButton({ title, count, depth = 0, selected, onClick }: SidebarButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={`w-full py-2 pr-3 rounded-lg text-left text-sm flex justify-between ${
        selected ? 'bg-accent-wash font-medium' : 'hover:bg-surface'
      }`}
      // Inside a folder, one step in from the folder's name (which starts past its arrow, at 22).
      style={{ paddingLeft: depth > 0 ? 22 + depth * 12 : 12 }}
      title={title}
    >
      <span className="truncate">{title}</span>
      {count !== undefined && <span className="text-xs text-text-tertiary flex-shrink-0 ml-1">{count}</span>}
    </button>
  );
}
