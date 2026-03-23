import { useRef, useState, useEffect, memo } from 'react';
import { Play, AlertTriangle, Image, Star, Loader2 } from 'lucide-react';
import { PhotoAsset } from '../../types';

interface Props {
  photo: PhotoAsset;
  size?: number;
  onClick?: () => void;
  getThumbnail: (fileHash: string, size: number) => Promise<string>;
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const PhotoThumbnail = memo(function PhotoThumbnail({
  photo, size = 200, onClick, getThumbnail,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Lazy-load via IntersectionObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { rootMargin: '300px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const isVideo = photo.kind === 'video';
  const isLive = photo.kind === 'live_photo';

  // Skip thumbnail fetch for raw video files — PIL can't decode MOV/MP4
  const skipThumbnail = isVideo;

  useEffect(() => {
    if (!visible || src || loading || hasError || skipThumbnail) return;
    let cancelled = false;
    setLoading(true);
    getThumbnail(photo.file_hash, size)
      .then(data => { if (!cancelled) setSrc(data); })
      .catch(() => { if (!cancelled) setHasError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, photo.file_hash, size, getThumbnail, hasError, skipThumbnail]);

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      className="relative cursor-pointer rounded-lg overflow-hidden bg-surface group select-none"
      style={{ aspectRatio: '1' }}
    >
      {src ? (
        <img
          src={`data:image/jpeg;base64,${src}`}
          alt={photo.filename}
          className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
          draggable={false}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-text-tertiary">
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          ) : skipThumbnail ? (
            <Play className="w-8 h-8 opacity-40" />
          ) : hasError ? (
            <AlertTriangle className="w-5 h-5 opacity-30" title={`Could not load: ${photo.filename}`} />
          ) : (
            <Image className="w-5 h-5 opacity-40" />
          )}
        </div>
      )}

      {/* Overlay badges */}
      <div className="absolute inset-0 flex flex-col justify-end p-1 pointer-events-none">
        <div className="flex items-end justify-between">
          {photo.favorite && (
            <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400 drop-shadow" />
          )}
          {isVideo && (
            <span className="ml-auto bg-black/65 text-white text-caption px-1 py-0.5 rounded leading-none inline-flex items-center gap-0.5">
              {photo.duration > 0 ? formatDuration(photo.duration) : <Play className="w-2.5 h-2.5" />}
            </span>
          )}
          {isLive && !isVideo && (
            <span className="ml-auto bg-black/65 text-white text-caption px-1 py-0.5 rounded leading-none font-medium">
              LIVE
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export default PhotoThumbnail;
