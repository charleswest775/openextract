declare module 'benz-amr-recorder' {
    export default class BenzAMRRecorder {
        constructor();
        initWithUrl(url: string): Promise<void>;
        initWithBlob(blob: Blob): Promise<void>;
        initWithArrayBuffer(buffer: ArrayBuffer): Promise<void>;
        play(): void;
        stop(): void;
        pause(): void;
        resume(): void;
        setVolume(vol: number): void;
        getDuration(): number;
        getCurrentPosition(): number;
        isPlaying(): boolean;
        onEnded(callback: () => void): void;
        onPlay(callback: () => void): void;
        onStop(callback: () => void): void;
        onPause(callback: () => void): void;
        onResume(callback: () => void): void;
        onTimeUpdate(callback: () => void): void;
    }
}
