export {};

import type { AppStateData, RecentSession } from './lib/appState';

declare global {
  interface Window {
    openextract: {
      call: (method: string, params?: any) => Promise<{ success: boolean; data?: any; error?: string }>;
      selectFolder: () => Promise<string | null>;
      saveFolder: () => Promise<string | null>;
      saveFile: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      writeFile: (filePath: string, content: string) => Promise<void>;
      openExternal: (url: string) => void;
      openPath: (filePath: string) => Promise<string>;
      /** Subscribe to JSON-RPC notifications from the Python sidecar (e.g. backup.progress). Returns a cleanup function. */
      onNotification: (callback: (notification: { method: string; params: Record<string, any> }) => void) => () => void;
      /** App state persistence */
      getAppState: () => Promise<AppStateData>;
      setFirstLaunchCompleted: () => Promise<void>;
      addSession: (session: RecentSession) => Promise<void>;
      removeSession: (id: string) => Promise<void>;
      getRecentSessions: () => Promise<RecentSession[]>;
      incrementExportCount: () => Promise<number>;
    };
  }
}

// ─── Photo types ─────────────────────────────────────────────────────────────

export interface PhotoAsset {
  uuid: string;
  filename: string;
  file_hash: string;
  kind: 'photo' | 'video' | 'live_photo' | 'screenshot' | 'burst' | 'selfie' | 'portrait' | 'panorama' | 'unknown';
  date_created: string | null;
  date_modified: string | null;
  width: number;
  height: number;
  duration: number;        // seconds; 0 for photos
  favorite: boolean;
  hidden: boolean;
  has_adjustments: boolean;
  burst_uuid: string | null;
  latitude: number | null;
  longitude: number | null;
  album_ids: string[];
  // Only present on get_photo_metadata response
  album_names?: string[];
}

export interface PhotoAlbum {
  id: string;
  title: string;
  asset_count: number;
  kind: 'user' | 'smart' | 'shared';
}

export interface ExportOptions {
  include_videos: boolean;
  include_live_photo_videos: boolean;
  format: 'original' | 'jpeg';
  jpeg_quality: number;          // 60–100
  folder_structure: 'flat' | 'by_date' | 'by_album';
  export_originals_if_edited: boolean;
  include_metadata_sidecar: boolean;
}

export interface FullPhotoResult {
  data: string;                  // base64
  mime_type: string;
  filename: string;
  converted?: boolean;
  error?: string;
}
