export {};

import type { AppStateData, RecentSession } from './lib/appState';

declare global {
  interface Window {
    openextract: {
      call: (method: string, params?: any) => Promise<{ success: boolean; data?: any; error?: string }>;
      /** Export conversations as PDF; same params as export_conversation(s) minus format. */
      exportPdf: (
        method: 'export_conversation' | 'export_conversations',
        params: any,
      ) => Promise<{ success: boolean; data?: { files: string[]; message_count: number }; error?: string }>;
      selectFolder: () => Promise<string | null>;
      saveFolder: () => Promise<string | null>;
      saveFile: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      writeFile: (filePath: string, content: string) => Promise<void>;
      openExternal: (url: string) => void;
      openPath: (filePath: string) => Promise<string>;
      /** Reveal a file or folder in Finder / Explorer. */
      showInFolder: (filePath: string) => Promise<void>;
      platform: 'darwin' | 'win32' | 'linux' | string;
      textSize: {
        get: () => Promise<TextSize>;
        set: (size: TextSize) => Promise<void>;
      };
      relaunch: () => Promise<void>;
      /** Subscribe to JSON-RPC notifications from the Python sidecar (e.g. backup.progress). Returns a cleanup function. */
      onNotification: (callback: (notification: { method: string; params: Record<string, any> }) => void) => () => void;
      getVersion: () => Promise<string>;
      updates: {
        getState: () => Promise<UpdatesState>;
        setAutoCheck: (enabled: boolean) => Promise<void>;
        /** "Not now": leave the setting unanswered and ask again in a week. */
        askLater: () => Promise<void>;
        check: () => Promise<void>;
        download: () => Promise<void>;
        install: () => Promise<void>;
        /** Subscribe to update status changes. Returns a cleanup function. */
        onStatus: (callback: (status: UpdateStatus) => void) => () => void;
      };
      /** App state persistence */
      getAppState: () => Promise<AppStateData>;
      setFirstLaunchCompleted: () => Promise<void>;
      addSession: (session: RecentSession) => Promise<void>;
      removeSession: (id: string) => Promise<void>;
      getRecentSessions: () => Promise<RecentSession[]>;
      /** `area` (e.g. 'calls') labels the follow-up "did it come out right?" card. */
      incrementExportCount: (area?: string) => Promise<number>;
      /** Called once, after the first successful export (or the next one, after the older star-only card), to show the share prompt. Returns a cleanup function. */
      onSharePrompt: (callback: (area?: string) => void) => () => void;
      feedback: {
        /** Scrubbed facts for the feedback form (no backup content, paths or names). */
        getDiagnostics: (reportedError?: string) => Promise<FeedbackDiagnostics>;
        /** Sends the report to openextract.app. Only ever called from the form's Send button. */
        send: (input: FeedbackSendInput) => Promise<FeedbackSendResult>;
        /** The email typed last time, kept on this computer to fill in the form. */
        savedEmail: () => Promise<string>;
        /** Reports found to be fixed that the user hasn't been told about yet. */
        fixedReports: () => Promise<FixedReport[]>;
        markAnnounced: (reference: string) => Promise<void>;
        /** A follow-up check found a fix. Returns a cleanup function. */
        onFixed: (callback: () => void) => () => void;
        optOutOfExportCheck: () => Promise<void>;
        /** "Glad it worked" was shown after "Looks right"; it isn't shown again. */
        thanksOffered: () => Promise<void>;
        /**
         * Shown at most once per run after an export. `offerThanks` says whether
         * "Looks right" may ask for a thank-you. Returns a cleanup function.
         */
        onExportCheck: (callback: (area?: string, offerThanks?: boolean) => void) => () => void;
      };
      /** Copy text to the system clipboard. */
      copyText: (text: string) => Promise<void>;
    };
  }
}

export type TextSize = 'default' | 'large' | 'larger';

// ─── Feedback types (mirror electron/feedback.ts) ────────────────────────────

export interface FeedbackDiagnostics {
  appVersion: string;
  os: string;
  backup: { model?: string; iosVersion?: string; encrypted?: boolean; sizeGB?: number | null; unfinished?: boolean } | null;
  loaded: string[];
  failed: string[];
  recentErrors: { at: string; method: string; message: string; count: number }[];
  logExcerpt: string;
  reportedError?: string;
}

// ─── Feedback reports (mirror electron/feedbackReports.ts) ───────────────────

export interface FeedbackSendInput {
  kind: string;
  area: string;
  details: string;
  diagnostics: string;
  email?: string;
  token: string;
  /** Thank-yous only: OK to quote on openextract.app, without the sender's name. */
  quote?: boolean;
}

export interface KnownFix {
  id: string;
  title: string;
  text: string;
  url?: string;
}

export type FeedbackSendResult =
  | { ok: true; reference: string; knownFixes: KnownFix[] }
  | { ok: false; error: string };

export interface FixedReport {
  reference: string;
  summary: string;
  sentAt: string;
  fixedIn?: string;
  inThisVersion: boolean;
}

// ─── Auto-update types (mirror electron/updater.ts) ──────────────────────────

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: string;
}

export interface UpdatesState {
  /** False in development and for installs that can't update themselves (e.g. an extracted AppImage). */
  supported: boolean;
  /** Running as a Flatpak, which Flathub keeps up to date. */
  flatpak?: boolean;
  /** null until the user has answered the "check automatically?" question. */
  autoCheck: boolean | null;
  /** "Not now" was picked on that question recently, so don't ask it yet. */
  askLater: boolean;
  currentVersion: string;
  releasesUrl: string;
  status: UpdateStatus;
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
