import { useState, useCallback, useEffect, useRef } from 'react';
import { sidecarCall } from '../lib/ipc';
import { PhotoAsset, PhotoAlbum, ExportOptions, FullPhotoResult } from '../types';

const BATCH_SIZE = 100;

// Module-level thumbnail cache shared across hook instances
const thumbnailCache = new Map<string, string>();

export function usePhotos(udid: string | undefined) {
  const [albums, setAlbums] = useState<PhotoAlbum[]>([]);
  const [photos, setPhotos] = useState<PhotoAsset[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<PhotoAlbum | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const albumIdRef = useRef<string | undefined>(undefined);

  // Load albums once when backup is opened
  useEffect(() => {
    if (!udid) return;
    sidecarCall<{ albums: PhotoAlbum[] }>('list_albums', { udid })
      .then(r => setAlbums(r.albums))
      .catch(() => {}); // albums are non-critical; gallery still works without them
  }, [udid]);

  // Load first page of photos, optionally filtered by album
  const loadPhotos = useCallback(async (albumId?: string) => {
    if (!udid) return;
    setLoading(true);
    setError(null);
    offsetRef.current = 0;
    albumIdRef.current = albumId;
    try {
      const r = await sidecarCall<{ photos: PhotoAsset[]; total: number }>(
        'list_photos',
        { udid, offset: 0, limit: BATCH_SIZE, album_id: albumId }
      );
      setPhotos(r.photos);
      setTotal(r.total);
      offsetRef.current = r.photos.length;
      setHasMore(r.photos.length < r.total);
    } catch (e: any) {
      setError(e.message || 'Failed to load photos');
    } finally {
      setLoading(false);
    }
  }, [udid]);

  // Initial load
  useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  const selectAlbum = useCallback((album: PhotoAlbum | null) => {
    setSelectedAlbum(album);
    setPhotos([]);
    loadPhotos(album?.id);
  }, [loadPhotos]);

  const loadMore = useCallback(async () => {
    if (!udid || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const r = await sidecarCall<{ photos: PhotoAsset[]; total: number }>(
        'list_photos',
        { udid, offset: offsetRef.current, limit: BATCH_SIZE, album_id: albumIdRef.current }
      );
      setPhotos(prev => [...prev, ...r.photos]);
      offsetRef.current += r.photos.length;
      setHasMore(offsetRef.current < r.total);
    } finally {
      setLoadingMore(false);
    }
  }, [udid, loadingMore, hasMore]);

  const getThumbnail = useCallback(async (fileHash: string, size: number): Promise<string> => {
    const cacheKey = `${fileHash}:${size}`;
    if (thumbnailCache.has(cacheKey)) {
      return thumbnailCache.get(cacheKey)!;
    }
    const r = await sidecarCall<{ data: string; error?: string }>(
      'get_photo_thumbnail',
      { udid, file_hash: fileHash, size }
    );
    if (r.data) {
      thumbnailCache.set(cacheKey, r.data);
      return r.data;
    }
    const msg = r.error || 'No thumbnail data';
    console.error('[Photos] Thumbnail failed:', fileHash.slice(0, 12), '—', msg);
    throw new Error(msg);
  }, [udid]);

  const getFullPhoto = useCallback(async (fileHash: string): Promise<FullPhotoResult> => {
    return sidecarCall<FullPhotoResult>('get_photo', { udid, file_hash: fileHash });
  }, [udid]);

  const exportPhotos = useCallback(async (
    outputDir: string,
    options: ExportOptions
  ): Promise<{ exported: number; errors: number }> => {
    return sidecarCall<{ exported: number; errors: number }>(
      'export_photos',
      { udid, output_dir: outputDir, options }
    );
  }, [udid]);

  return {
    albums,
    photos,
    selectedAlbum,
    loading,
    loadingMore,
    hasMore,
    total,
    error,
    selectAlbum,
    loadMore,
    getThumbnail,
    getFullPhoto,
    exportPhotos,
  };
}
