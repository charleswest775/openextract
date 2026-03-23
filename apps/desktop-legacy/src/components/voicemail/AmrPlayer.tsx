import { useEffect, useRef, useState } from 'react';
import BenzAMRRecorder from 'benz-amr-recorder';

interface Props {
    base64Data: string;
    mimeType: string;
}

export default function AmrPlayer({ base64Data, mimeType }: Props) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const playerRef = useRef<BenzAMRRecorder | null>(null);
    const timerRef = useRef<number | null>(null);

    useEffect(() => {
        let mounted = true;
        const initPlayer = async () => {
            try {
                const binStr = atob(base64Data);
                const len = binStr.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binStr.charCodeAt(i);
                }

                const blob = new Blob([bytes], { type: mimeType });
                const amr = new BenzAMRRecorder();
                await amr.initWithBlob(blob);

                if (mounted) {
                    playerRef.current = amr;
                    setIsLoaded(true);
                    setDuration(amr.getDuration());

                    amr.onPlay(() => setIsPlaying(true));
                    amr.onPause(() => setIsPlaying(false));
                    amr.onStop(() => {
                        setIsPlaying(false);
                        setCurrentTime(0);
                    });
                    amr.onEnded(() => {
                        setIsPlaying(false);
                        setCurrentTime(0);
                    });
                }
            } catch (err: any) {
                if (mounted) {
                    console.error('Failed to initialize AMR player:', err);
                    setError('Unable to load audio');
                }
            }
        };

        initPlayer();

        return () => {
            mounted = false;
            if (timerRef.current) {
                window.clearInterval(timerRef.current);
            }
            if (playerRef.current) {
                playerRef.current.stop();
            }
        };
    }, [base64Data]);

    // Update current time manually since benz-amr-recorder doesn't trigger onTimeUpdate by default in some versions
    useEffect(() => {
        if (isPlaying && playerRef.current) {
            timerRef.current = window.setInterval(() => {
                setCurrentTime(playerRef.current?.getCurrentPosition() || 0);
            }, 100);
        } else if (timerRef.current) {
            window.clearInterval(timerRef.current);
            timerRef.current = null;
        }

        return () => {
            if (timerRef.current) window.clearInterval(timerRef.current);
        };
    }, [isPlaying]);

    const togglePlay = () => {
        if (!playerRef.current || !isLoaded) return;
        if (playerRef.current.isPlaying()) {
            playerRef.current.pause();
        } else {
            playerRef.current.play();
        }
    };

    const formatTime = (seconds: number) => {
        if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    if (error) {
        return <div className="text-sm text-red-500">{error}</div>;
    }

    if (!isLoaded) {
        return <div className="text-sm text-gray-500 animate-pulse flex items-center h-10 px-2">Loading audio...</div>;
    }

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <div className="flex items-center gap-3 bg-gray-100 rounded-full px-3 py-2 w-full max-w-sm">
            <button
                onClick={togglePlay}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-blue-600 hover:bg-blue-700 text-white flex-shrink-0 transition-colors shadow-sm"
                aria-label={isPlaying ? 'Pause' : 'Play'}
            >
                {isPlaying ? (
                    // Pause Icon
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                    </svg>
                ) : (
                    // Play Icon
                    <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                    </svg>
                )}
            </button>

            <span className="text-xs font-mono text-gray-600 tabular-nums w-10 text-right shrink-0">
                {formatTime(currentTime)}
            </span>

            <div className="flex-1 h-2 bg-gray-300 rounded-full overflow-hidden relative" onClick={(e) => {
                // Basic seek support (note: benz-amr-recorder may not support seeking accurately, so we just visual only or ignore)
            }}>
                <div
                    className="absolute top-0 left-0 h-full bg-blue-500 transition-all duration-100 ease-linear"
                    style={{ width: `${progress}%` }}
                />
            </div>

            <span className="text-xs font-mono text-gray-500 tabular-nums w-10 text-left shrink-0">
                {formatTime(duration)}
            </span>
        </div>
    );
}
