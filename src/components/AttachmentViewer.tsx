import { useEffect, useState } from 'react';
import { Loader2, Paperclip, Video } from 'lucide-react';
import { sidecarCall } from '../lib/ipc';
import { Attachment } from '../hooks/useMessages';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.webp', '.bmp', '.tiff', '.tif'];
const VIDEO_EXTENSIONS = ['.mov', '.mp4', '.m4v', '.3gp'];

function isImageAttachment(attachment: Attachment): boolean {
    if (attachment.mime_type?.startsWith('image/')) return true;
    return [attachment.transfer_name, attachment.filename]
        .filter(Boolean)
        .some(name => IMAGE_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext)));
}

function isVideoAttachment(attachment: Attachment): boolean {
    if (attachment.mime_type?.startsWith('video/')) return true;
    return [attachment.transfer_name, attachment.filename]
        .filter(Boolean)
        .some(name => VIDEO_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext)));
}

interface Props {
    udid: string;
    attachment: Attachment;
}

export default function AttachmentViewer({ udid, attachment }: Props) {
    const [data, setData] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const isImage = isImageAttachment(attachment);
    const isVideo = isVideoAttachment(attachment);

    useEffect(() => {
        if (!isImage && !isVideo) {
            return;
        }

        let cancelled = false;
        const fetchAttachment = async () => {
            setData(null);
            setError(null);
            setLoading(true);
            try {
                const result = await sidecarCall<{ data: string; mime_type: string; filename: string }>(
                    isVideo ? 'get_video_thumbnail' : 'get_attachment',
                    { udid, attachment_id: attachment.attachment_id }
                );
                if (!cancelled) setData(`data:${result.mime_type};base64,${result.data}`);
            } catch (err: any) {
                if (!cancelled) setError(err.message || `Failed to load ${isVideo ? 'video thumbnail' : 'image'}`);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        void fetchAttachment();
        return () => { cancelled = true; };
    }, [udid, attachment.attachment_id, isImage, isVideo]);

    if (!isImage && !isVideo) {
        return (
            <div className="flex items-center space-x-2 text-body italic text-text-secondary">
                <Paperclip className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{attachment.transfer_name || attachment.filename || 'Attachment'}</span>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex items-center gap-1.5 text-body italic text-text-tertiary">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading {isVideo ? 'video thumbnail' : 'image'}...
            </div>
        );
    }

    if (error) {
        return <div className="text-body text-red-400 italic">Error: {error}</div>;
    }

    if (data) {
        return (
            <div className="mt-1 flex flex-col items-start max-w-sm">
                <div
                    className="relative inline-flex"
                    onClick={e => e.stopPropagation()}
                >
                    <img
                        src={data}
                        alt={attachment.transfer_name || 'Attachment'}
                        className="rounded-lg object-contain max-h-64"
                        style={{ border: '0.5px solid var(--border-default)' }}
                    />
                    {isVideo && (
                        <span className="absolute inset-0 flex items-center justify-center">
                            <span className="rounded-full bg-black/65 p-2 text-white">
                                <Video className="w-5 h-5" />
                            </span>
                        </span>
                    )}
                </div>
            </div>
        );
    }

    return <div className="text-body italic text-text-tertiary">Unknown attachment</div>;
}
