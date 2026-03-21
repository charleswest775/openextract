/**
 * IPC client for communicating with the Python sidecar via Electron.
 * In dev mode without Electron, falls back to mock data.
 */

export type DataSourceId = 'messages' | 'photos' | 'contacts' | 'calls' | 'voicemail' | 'notes' | 'chrome' | 'youtube' | 'location';

export interface DataSource {
  id: DataSourceId;
  label: string;
  available: boolean;
  record_count: number;
}

export interface DetectedApp {
  bundle_id: string;
  display_name: string;
  db_files: string[];
}

export interface ScanResult {
  sources: DataSource[];
  detected: DetectedApp[];
}

const isElectron = typeof window !== 'undefined' && window.openextract;

export async function sidecarCall<T = any>(method: string, params: any = {}): Promise<T> {
  if (!isElectron) {
    console.warn(`[Mock] sidecar.${method}`, params);
    throw new Error('Not running in Electron. Start with: npm run dev');
  }

  const result = await window.openextract.call(method, params);
  if (!result.success) {
    throw new Error(result.error || 'Unknown error');
  }
  return result.data as T;
}

export async function selectFolder(): Promise<string | null> {
  if (!isElectron) return null;
  return window.openextract.selectFolder();
}

export async function saveFolder(): Promise<string | null> {
  if (!isElectron) return null;
  return window.openextract.saveFolder();
}
