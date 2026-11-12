export type AppState = 'first_visit' | 'returned_no_data' | 'has_data';

export interface RecentSession {
  id: string;
  type: 'device' | 'case';
  name: string;
  subtitle: string;
  exportCount: number;
  lastOpened: string;
  sizeGB?: number;
  iosVersion?: string;
  caseLabel?: string;
  backupCount?: number;
  backupDir?: string;
  /** The backup stopped partway, as of the last time it was opened. */
  unfinished?: boolean;
}

export interface AppStateData {
  state: AppState;
  totalDevices: number;
  totalSizeGB: number;
  totalMessages: number;
  totalExports: number;
  sessions: RecentSession[];
  stats: { totalExports: number };
}
