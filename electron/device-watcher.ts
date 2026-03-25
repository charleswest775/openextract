/**
 * DeviceWatcher — polls the Python sidecar for connected iOS devices
 * and triggers auto-backup + extraction when appropriate.
 *
 * Runs in the Electron main process. Communicates with the sidecar via
 * its JSON-RPC call() method to list devices and start backups.
 */

export interface DeviceInfo {
  udid: string;
  name: string;
  ios_version: string;
  connection_type: 'usb' | 'wifi';
}

export interface BackupHistory {
  udid: string;
  lastBackupDate: Date | null;
  lastExtractionDate: Date | null;
}

type DeviceCallback = (device: DeviceInfo) => void;
type BackupCompleteCallback = (device: DeviceInfo, backupPath: string) => void;
type ErrorCallback = (device: DeviceInfo | null, phase: string, error: string) => void;

export class DeviceWatcher {
  private pollInterval = 10_000; // 10 seconds
  private backupCooldownHours = 24;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private knownDevices: Map<string, DeviceInfo> = new Map();
  private backupHistory: Map<string, BackupHistory> = new Map();
  private backupsInProgress: Set<string> = new Set();

  // External dependencies injected by main.ts
  private sidecar: any;

  // Callbacks
  public onDeviceConnected: DeviceCallback | null = null;
  public onDeviceDisconnected: DeviceCallback | null = null;
  public onBackupStarted: DeviceCallback | null = null;
  public onBackupComplete: BackupCompleteCallback | null = null;
  public onExtractionComplete: ((udid: string, count: number) => void) | null = null;
  public onError: ErrorCallback | null = null;

  constructor(sidecar: any) {
    this.sidecar = sidecar;
  }

  /**
   * Start the polling loop. Safe to call multiple times.
   */
  start(): void {
    if (this.pollTimer) return;
    console.log('[DeviceWatcher] Starting device polling');
    this.pollTimer = setInterval(() => this.poll(), this.pollInterval);
    // Immediate first poll
    this.poll();
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[DeviceWatcher] Stopped');
  }

  /**
   * Set how often to check for devices (milliseconds).
   */
  setPollInterval(ms: number): void {
    this.pollInterval = ms;
    if (this.pollTimer) {
      this.stop();
      this.start();
    }
  }

  /**
   * Set minimum hours between automatic backups for the same device.
   */
  setBackupCooldown(hours: number): void {
    this.backupCooldownHours = hours;
  }

  /**
   * One poll cycle: list devices, diff against known, trigger actions.
   */
  private async poll(): Promise<void> {
    if (!this.sidecar) return;

    let devices: DeviceInfo[];
    try {
      const result = await this.sidecar.call('backup.list_devices', {});
      devices = (result?.devices || result || []) as DeviceInfo[];
    } catch {
      // Sidecar not ready or pymobiledevice3 not installed — silently skip
      return;
    }

    const currentUdids = new Set(devices.map((d: DeviceInfo) => d.udid));

    // Detect new devices
    for (const device of devices) {
      if (!this.knownDevices.has(device.udid)) {
        console.log(`[DeviceWatcher] Device connected: ${device.name} (${device.udid})`);
        this.knownDevices.set(device.udid, device);
        this.onDeviceConnected?.(device);

        // Auto-backup decision
        if (this.shouldBackup(device.udid)) {
          this.triggerAutoBackup(device);
        }
      }
    }

    // Detect disconnected devices
    for (const [udid, device] of this.knownDevices) {
      if (!currentUdids.has(udid)) {
        console.log(`[DeviceWatcher] Device disconnected: ${device.name}`);
        this.knownDevices.delete(udid);
        this.onDeviceDisconnected?.(device);
      }
    }
  }

  /**
   * Decide whether a device should be backed up now.
   */
  private shouldBackup(udid: string): boolean {
    if (this.backupsInProgress.has(udid)) {
      return false; // Already backing up
    }

    const history = this.backupHistory.get(udid);
    if (!history || !history.lastBackupDate) {
      return true; // Never backed up
    }

    const hoursSince = (Date.now() - history.lastBackupDate.getTime()) / (1000 * 60 * 60);
    return hoursSince >= this.backupCooldownHours;
  }

  /**
   * Start an automatic backup for the given device.
   */
  private async triggerAutoBackup(device: DeviceInfo): Promise<void> {
    if (this.backupsInProgress.has(device.udid)) return;
    this.backupsInProgress.add(device.udid);

    console.log(`[DeviceWatcher] Auto-backup starting for ${device.name}`);
    this.onBackupStarted?.(device);

    try {
      // Determine output directory
      const os = require('os');
      const path = require('path');
      const outputDir = path.join(os.homedir(), '.openextract', 'backups', device.udid, 'latest');

      const result = await this.sidecar.call(
        'backup.start',
        {
          udid: device.udid,
          output_dir: outputDir,
          encrypted: false,
        },
        7_200_000 // 2 hour timeout
      );

      const backupPath = result?.backup_path || outputDir;

      // Update history
      this.backupHistory.set(device.udid, {
        udid: device.udid,
        lastBackupDate: new Date(),
        lastExtractionDate: this.backupHistory.get(device.udid)?.lastExtractionDate || null,
      });

      console.log(`[DeviceWatcher] Backup complete for ${device.name}`);
      this.onBackupComplete?.(device, backupPath);

      // Auto-extract after backup
      await this.triggerAutoExtraction(device);
    } catch (err: any) {
      console.error(`[DeviceWatcher] Backup failed for ${device.name}:`, err.message);
      this.onError?.(device, 'backup', err.message || 'Unknown backup error');
    } finally {
      this.backupsInProgress.delete(device.udid);
    }
  }

  /**
   * Trigger automatic extraction after a backup completes.
   */
  private async triggerAutoExtraction(device: DeviceInfo): Promise<void> {
    console.log(`[DeviceWatcher] Auto-extraction starting for ${device.name}`);

    const os = require('os');
    const path = require('path');
    const backupDir = path.join(os.homedir(), '.openextract', 'backups', device.udid, 'latest');

    try {
      // First ensure the backup is opened — pass backup_dir so sidecar can find it
      await this.sidecar.call('open_backup', { udid: device.udid, backup_dir: backupDir });

      // Run extraction
      const result = await this.sidecar.call(
        'extraction.start',
        { udid: device.udid, backup_dir: backupDir },
        7_200_000
      );

      const count = result?.total_artifacts || 0;

      // Update history
      const history = this.backupHistory.get(device.udid);
      if (history) {
        history.lastExtractionDate = new Date();
      }

      console.log(`[DeviceWatcher] Extraction complete: ${count} artifacts from ${device.name}`);
      this.onExtractionComplete?.(device.udid, count);
    } catch (err: any) {
      console.error(`[DeviceWatcher] Extraction failed for ${device.name}:`, err.message);
      this.onError?.(device, 'extraction', err.message || 'Unknown extraction error');
    }
  }

  /**
   * Get currently connected devices.
   */
  getConnectedDevices(): DeviceInfo[] {
    return Array.from(this.knownDevices.values());
  }
}
