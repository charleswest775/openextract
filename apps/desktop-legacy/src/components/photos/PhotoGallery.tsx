import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Download, Loader2 } from 'lucide-react';
import { BackupInfo } from '../../hooks/useBackup';
import { usePhotos } from '../../hooks/usePhotos';
import { PhotoAlbum } from '../../types';
import PhotoThumbnail from './PhotoThumbnail';
import PhotoLightbox from './PhotoLightbox';
import ExportDialog from './ExportDialog';

interface Props {
  backup: BackupInfo;
}

const KIND_OPTIONS = [
  { value: 'all', label: 'All Types' },
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'live_photo', label: 'Live Photos' },
  { value: 'screenshot', label: 'Screenshots' },
];

export default function PhotoGallery({ backup }: Props) {
  const {
    albums, photos, selectedAlbum, loading, loadingMore, hasMore, total, error,
    selectAlbum, loadMore, getThumbnail, getFullPhoto, exportPhotos,
  } = usePhotos(backup.udid);

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Infinite scroll trigger
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 400;
      if (nearBottom && hasMore && !loadingMore) loadMore();
    };
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, [hasMore, loadingMore, loadMore]);

  const filteredPhotos = photos.filter(p => {
    if (search && !p.filename.toLowerCase().includes(search.toLowerCase())) return false;
    if (kindFilter !== 'all' && p.kind !== kindFilter) return false;
    return true;
  });

  const handleAlbumClick = useCallback((album: PhotoAlbum) => {
    const isActive = selectedAlbum?.id === album.id;
    selectAlbum(isActive ? null : album);
  }, [selectedAlbum, selectAlbum]);

  return (
    <div className="flex h-full bg-base text-text-primary overflow-hidden">
      {/* Album sidebar */}
      <aside className="w-52 flex-shrink-0 flex flex-col overflow-hidden" style={{ borderRight: '0.5px solid var(--border-default)' }}>
        <p className="text-caption uppercase tracking-wider text-text-tertiary px-3 pt-3 pb-1 flex-shrink-0">
          Albums
        </p>
        <div className="flex-1 overflow-y-auto py-1">
          {albums.map(album => {
            const active = selectedAlbum?.id === album.id;
            return (
              <button
                key={album.id}
                onClick={() => handleAlbumClick(album)}
                className={`w-full text-left px-3 py-1.5 text-body flex items-center justify-between gap-2 transition-colors focus:outline-none focus:shadow-focus ${
                  active
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:bg-surface'
                }`}
              >
                <span className="truncate flex-1">{album.title}</span>
                <span className={`text-caption flex-shrink-0 ${active ? 'text-white/70' : 'text-text-tertiary'}`}>
                  {album.asset_count.toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0 bg-base" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search filename..."
              className="bg-surface text-text-primary text-body pl-8 pr-3 py-1.5 rounded-lg w-44 focus:outline-none focus:shadow-focus placeholder:text-text-tertiary"
              style={{ border: '0.5px solid var(--border-default)' }}
            />
          </div>
          <select
            value={kindFilter}
            onChange={e => setKindFilter(e.target.value)}
            className="bg-surface text-text-primary text-body px-2 py-1.5 rounded-lg focus:outline-none focus:shadow-focus"
            style={{ border: '0.5px solid var(--border-default)' }}
          >
            {KIND_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span className="text-caption text-text-tertiary ml-1">
            {filteredPhotos.length.toLocaleString()}
            {total > photos.length && ` of ${total.toLocaleString()}`}
          </span>
          <button
            onClick={() => setShowExport(true)}
            className="ml-auto bg-accent hover:bg-accent-hover text-white text-body px-3 py-1.5 rounded-lg transition-colors focus:outline-none focus:shadow-focus inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-3 mt-2 px-3 py-2 bg-red-50 rounded-lg text-body text-red-700 flex-shrink-0" style={{ border: '0.5px solid var(--border-danger)' }}>
            {error}
          </div>
        )}

        {/* Photo grid */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-2">
          {loading && photos.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
              <Loader2 className="w-8 h-8 animate-spin mb-3 text-accent" />
              <p className="text-body">Loading photos...</p>
            </div>
          ) : filteredPhotos.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-tertiary">
              <p className="text-body">{photos.length === 0 ? 'No photos in backup' : 'No results'}</p>
            </div>
          ) : (
            <>
              <div
                className="grid gap-1"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
              >
                {filteredPhotos.map((photo, i) => (
                  <PhotoThumbnail
                    key={photo.uuid || photo.file_hash}
                    photo={photo}
                    size={200}
                    onClick={() => setLightboxIndex(i)}
                    getThumbnail={getThumbnail}
                  />
                ))}
              </div>

              {/* Load more spinner */}
              {loadingMore && (
                <div className="flex justify-center py-5">
                  <Loader2 className="w-6 h-6 animate-spin text-accent" />
                </div>
              )}

              {/* End-of-list indicator */}
              {!hasMore && filteredPhotos.length > 0 && (
                <p className="text-center text-text-tertiary text-caption py-4">
                  All {filteredPhotos.length.toLocaleString()} items loaded
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <PhotoLightbox
          photos={filteredPhotos}
          initialIndex={lightboxIndex}
          getFullPhoto={getFullPhoto}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      {/* Export dialog */}
      {showExport && (
        <ExportDialog
          onClose={() => setShowExport(false)}
          onExport={exportPhotos}
        />
      )}
    </div>
  );
}
