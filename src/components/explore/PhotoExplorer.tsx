import { useState, useEffect, useCallback, useRef } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { SearchIcon, ExportIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';

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

interface PhotoAlbum {
  id: string;
  title: string;
  asset_count: number;
}

const BATCH_SIZE = 100;
const THUMB_CONCURRENCY = 6;

// Module-level cache: stores base64 data for successful thumbs.
// Failed hashes are tracked separately so they can be retried on remount.
const thumbnailDataCache = new Map<string, string>();
const thumbnailFailedSet = new Set<string>();

// Track in-flight requests so we don't double-request
const thumbnailInflight = new Set<string>();

interface Props {
  udid: string;
}

export default function PhotoExplorer({ udid }: Props) {
  const [photos, setPhotos] = useState<PhotoAsset[]>([]);
  const [albums, setAlbums] = useState<PhotoAlbum[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(new Set());
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [exporting, setExporting] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);

  const offsetRef = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    loadAlbums();
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

  async function loadPhotos(offset: number, albumId?: string | null) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await sidecarCall<{ photos: PhotoAsset[]; total: number }>(
        'list_photos',
        { udid, offset, limit: BATCH_SIZE, album_id: albumId ?? undefined }
      );
      if (!mountedRef.current) return;

      if (offset === 0) {
        setPhotos(result.photos);
      } else {
        setPhotos(prev => [...prev, ...result.photos]);
      }
      setTotal(result.total);
      offsetRef.current = offset + result.photos.length;
      setHasMore(offset + result.photos.length < result.total);

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
    } finally {
      setLoading(false);
      loadingRef.current = false;
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

  const handleAlbumSelect = useCallback((albumId: string | null) => {
    setSelectedAlbum(albumId);
    setPhotos([]);
    setThumbnails({});
    setFailedThumbs(new Set());
    offsetRef.current = 0;
    loadingRef.current = false;
    loadPhotos(0, albumId);
  }, [udid]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400 && hasMore && !loadingRef.current) {
      loadPhotos(offsetRef.current, selectedAlbum);
    }
  }, [hasMore, selectedAlbum]);

  async function handleExport() {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    try {
      await sidecarCall('export_photos', {
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
        },
      });
      window.openextract.incrementExportCount();
    } finally {
      setExporting(false);
    }
  }

  async function handlePhotoClick(photo: PhotoAsset) {
    const isVideo = photo.kind === 'video' || photo.duration > 0;
    if (!isVideo) return; // TODO: full-size image viewer

    setVideoLoading(true);
    try {
      const result = await sidecarCall<{ path?: string; error?: string }>(
        'get_photo_path', { udid, file_hash: photo.file_hash }
      );
      if (result.path && window.openextract?.openPath) {
        // Open in system default media player (handles HEVC, MOV, etc.)
        window.openextract.openPath(result.path);
      }
    } catch {
      // Ignore
    } finally {
      setVideoLoading(false);
    }
  }

  const filteredPhotos = photos.filter(p => {
    if (kindFilter !== 'all' && p.kind !== kindFilter) return false;
    if (search && !p.filename.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="h-full flex flex-col">
      {/* Hearth header */}
      <div className="flex items-end justify-between gap-4 bg-base" style={{ padding: '20px 28px 14px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 }}>
        <div className="min-w-0 flex-1">
          <div className="hearth-eyebrow mb-1.5">
            Photos{total > 0 && ` · ${total.toLocaleString()} recovered`}
          </div>
          <h1 className="hearth-title text-3xl">
            Albums <span className="font-serif-italic text-accent">across the years.</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="text-xs bg-surface border border-rule rounded-full px-3 py-1.5"
          >
            <option value="all">All types</option>
            <option value="photo">Photos</option>
            <option value="video">Videos</option>
            <option value="live_photo">Live Photos</option>
            <option value="screenshot">Screenshots</option>
          </select>
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" size={13} />
            <input
              type="text"
              placeholder="Search photos..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3 py-1.5 text-sm bg-surface rounded-full border border-rule focus:outline-none focus:border-accent w-40"
            />
          </div>
          <button onClick={handleExport} disabled={exporting} className="hearth-ghost-btn">
            <ExportIcon size={13} />
            Export
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Album sidebar */}
        {albums.length > 0 && (
          <div className="w-[180px] flex-shrink-0 border-r border-gray-200 overflow-y-auto py-2">
            <button
              onClick={() => handleAlbumSelect(null)}
              className={`w-full px-3 py-1.5 text-left text-sm ${
                selectedAlbum === null ? 'bg-gray-100 font-medium' : 'hover:bg-gray-50'
              }`}
            >
              All Photos
            </button>
            {albums.map((album) => (
              <button
                key={album.id}
                onClick={() => handleAlbumSelect(album.id)}
                className={`w-full px-3 py-1.5 text-left text-sm flex justify-between ${
                  selectedAlbum === album.id ? 'bg-gray-100 font-medium' : 'hover:bg-gray-50'
                }`}
              >
                <span className="truncate">{album.title}</span>
                <span className="text-xs text-gray-400 flex-shrink-0 ml-1">{album.asset_count}</span>
              </button>
            ))}
          </div>
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
                    <div className="w-full h-full flex flex-col items-center justify-center bg-gray-800 text-gray-400">
                      {/* Play triangle icon */}
                      <svg className="w-10 h-10 mb-1 text-gray-300 group-hover:text-white transition-colors" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      <span className="text-[10px] text-gray-500">{photo.filename.length > 16 ? photo.filename.slice(0, 14) + '...' : photo.filename}</span>
                    </div>
                  ) : failed ? (
                    <div className="w-full h-full flex flex-col items-center justify-center text-gray-300">
                      <svg className="w-8 h-8 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                      </svg>
                      <span className="text-[10px]">{photo.filename.length > 16 ? photo.filename.slice(0, 14) + '...' : photo.filename}</span>
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                    </div>
                  )}
                  {photo.duration > 0 && (
                    <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[10px] px-1 rounded">
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
          {!loading && filteredPhotos.length === 0 && (
            <div className="text-center py-8 text-sm text-gray-400">No photos found</div>
          )}
        </div>
      </div>

      {/* Video loading overlay */}
      {videoLoading && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 pointer-events-none">
          <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}
