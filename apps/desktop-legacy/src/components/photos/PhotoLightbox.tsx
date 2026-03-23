import { useState, useEffect, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, AlertTriangle, Star, Info, Loader2 } from 'lucide-react';
import { PhotoAsset, FullPhotoResult } from '../../types';

interface Props {
  photos: PhotoAsset[];
  initialIndex: number;
  getFullPhoto: (fileHash: string) => Promise<FullPhotoResult>;
  onClose: () => void;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-3">
      <p className="text-text-tertiary text-caption uppercase tracking-wider">{label}</p>
      <p className="text-text-primary text-caption break-all mt-0.5">{value}</p>
    </div>
  );
}

export default function PhotoLightbox({ photos, initialIndex, getFullPhoto, onClose }: Props) {
  const [index, setIndex] = useState(initialIndex);
  const [photoData, setPhotoData] = useState<FullPhotoResult | null>(null);
  const [fetching, setFetching] = useState(false);
  const [showMeta, setShowMeta] = useState(true);

  const photo = photos[index];

  const loadPhoto = useCallback(async (p: PhotoAsset) => {
    setPhotoData(null);
    setFetching(true);
    try {
      const result = await getFullPhoto(p.file_hash);
      setPhotoData(result);
    } catch (e: any) {
      setPhotoData({ error: e.message || 'Failed to load', data: '', mime_type: '', filename: '' });
    } finally {
      setFetching(false);
    }
  }, [getFullPhoto]);

  useEffect(() => { loadPhoto(photo); }, [photo, loadPhoto]);

  const prev = useCallback(() => setIndex(i => Math.max(0, i - 1)), []);
  const next = useCallback(() => setIndex(i => Math.min(photos.length - 1, i + 1)), [photos.length]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, prev, next]);

  const isVideo = photo.kind === 'video';
  const dataSrc = photoData && !photoData.error
    ? `data:${photoData.mime_type};base64,${photoData.data}`
    : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-2 flex-shrink-0 bg-gray-950" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
        <button
          onClick={onClose}
          className="text-text-tertiary hover:text-text-primary transition-colors focus:outline-none focus:shadow-focus rounded-md p-0.5"
        >
          <X className="w-4 h-4" />
        </button>
        <span className="text-text-secondary text-body truncate flex-1">{photo.filename}</span>
        <span className="text-text-tertiary text-caption flex-shrink-0">
          {index + 1} / {photos.length}
        </span>
        <button
          onClick={() => setShowMeta(m => !m)}
          className={`text-caption px-2 py-1 rounded-lg transition-colors focus:outline-none focus:shadow-focus inline-flex items-center gap-1 ${
            showMeta
              ? 'bg-accent text-white'
              : 'text-text-tertiary hover:text-text-primary'
          }`}
          style={showMeta ? undefined : { border: '0.5px solid var(--border-default)' }}
        >
          <Info className="w-3 h-3" />
          Info
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Image / video viewer */}
        <div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black">
          {/* Prev button */}
          {index > 0 && (
            <button
              onClick={prev}
              className="absolute left-3 z-10 bg-black/50 hover:bg-black/80 text-white w-9 h-9 rounded-full flex items-center justify-center transition-colors focus:outline-none focus:shadow-focus"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}

          {/* Next button */}
          {index < photos.length - 1 && (
            <button
              onClick={next}
              className="absolute right-3 z-10 bg-black/50 hover:bg-black/80 text-white w-9 h-9 rounded-full flex items-center justify-center transition-colors focus:outline-none focus:shadow-focus"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}

          {fetching ? (
            <Loader2 className="w-10 h-10 animate-spin text-accent" />
          ) : photoData?.error ? (
            <div className="text-text-tertiary text-body text-center">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-yellow-500" />
              <p>Failed to load photo</p>
              <p className="text-caption mt-1 text-text-tertiary">{photoData.error}</p>
            </div>
          ) : dataSrc ? (
            isVideo ? (
              <video
                key={dataSrc}
                src={dataSrc}
                controls
                autoPlay
                className="max-w-full max-h-full outline-none"
              />
            ) : (
              <img
                key={dataSrc}
                src={dataSrc}
                alt={photo.filename}
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            )
          ) : null}
        </div>

        {/* Metadata panel */}
        {showMeta && (
          <aside className="w-60 flex-shrink-0 bg-gray-950 overflow-y-auto p-4" style={{ borderLeft: '0.5px solid var(--border-default)' }}>
            <p className="text-text-tertiary text-caption uppercase tracking-wider mb-3">Details</p>
            <MetaRow label="Filename" value={photo.filename} />
            <MetaRow label="Type" value={photo.kind} />
            {photo.date_created && (
              <MetaRow label="Created" value={new Date(photo.date_created).toLocaleString()} />
            )}
            {photo.date_modified && (
              <MetaRow label="Modified" value={new Date(photo.date_modified).toLocaleString()} />
            )}
            {photo.width > 0 && (
              <MetaRow label="Dimensions" value={`${photo.width} x ${photo.height}`} />
            )}
            {photo.duration > 0 && (
              <MetaRow label="Duration" value={`${photo.duration.toFixed(1)}s`} />
            )}
            {photo.latitude != null && photo.longitude != null && (
              <MetaRow
                label="Location"
                value={`${photo.latitude.toFixed(5)}, ${photo.longitude.toFixed(5)}`}
              />
            )}
            {photo.favorite && (
              <div className="mb-3">
                <p className="text-text-tertiary text-caption uppercase tracking-wider">Favourite</p>
                <p className="text-text-primary text-caption mt-0.5 inline-flex items-center gap-1">
                  Yes <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
                </p>
              </div>
            )}
            {photo.has_adjustments && <MetaRow label="Edited" value="Yes" />}
            {photo.burst_uuid && <MetaRow label="Burst" value="Yes" />}
            {photo.hidden && <MetaRow label="Hidden" value="Yes" />}
          </aside>
        )}
      </div>
    </div>
  );
}
