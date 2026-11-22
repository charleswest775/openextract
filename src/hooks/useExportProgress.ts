import { useEffect, useState } from 'react';
import {
  chatSaveAfter, chatSaveStatus, exportProgressFor, NO_CHAT_SAVE, type ChatSave, type ExportProgress,
} from '../lib/exportProgress';

/**
 * How far along a save of this kind is, from the engine's export.progress
 * notifications, while `active` (the save is running). Null before the first
 * update and once the save is over.
 */
export function useExportProgress(kind: string, active: boolean): ExportProgress | null {
  const [progress, setProgress] = useState<ExportProgress | null>(null);

  useEffect(() => {
    setProgress(null);
    if (!active || !window.openextract?.onNotification) return;
    return window.openextract.onNotification(notification => {
      const update = exportProgressFor(kind, notification);
      if (update) setProgress(update);
    });
  }, [kind, active]);

  return active ? progress : null;
}

/**
 * The line and bar for a save of Messages conversations or WhatsApp chats in any
 * format, while `active`: what's being read, which PDF is being saved or printed.
 */
export function useChatSaveProgress(
  kind: 'messages' | 'whatsapp',
  active: boolean,
): { text: string; percent: number } | null {
  const [save, setSave] = useState<ChatSave>(NO_CHAT_SAVE);

  useEffect(() => {
    setSave(NO_CHAT_SAVE);
    if (!active || !window.openextract?.onNotification) return;
    return window.openextract.onNotification(notification => {
      setSave(current => chatSaveAfter(current, kind, notification));
    });
  }, [kind, active]);

  return active ? chatSaveStatus(save, kind === 'whatsapp' ? 'chat' : 'conversation') : null;
}
