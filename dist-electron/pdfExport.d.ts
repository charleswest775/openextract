import { safeBaseName } from './newFile';
type Sidecar = {
    call: (method: string, params: any, timeoutMs?: number) => Promise<any>;
};
export type PdfExportMethod = 'export_conversation' | 'export_conversations' | 'export_whatsapp_chat' | 'export_whatsapp_chats' | 'export_person' | 'export_notes' | 'export_calls' | 'export_browser_history' | 'export_recovered_messages';
/** A conversation whose PDF was split by year, for telling the person why. */
export interface PdfSplit {
    /** Whose PDF: the conversation's name, or null for everything saved into one file ("merged"). */
    name: string | null;
    /** The parts, in order: "2023", "2019–2021", "Jan–Jun 2024". */
    labels: string[];
    messages: number;
    images: number;
    /** About how big one PDF of all of it would have been. */
    estimate: {
        pages: number;
        megabytes: number;
    };
}
/**
 * Where a save of conversations or chats has got to, sent to the window as pdf.progress
 * (src/lib/exportProgress.ts). `part` of `parts` is the engine call it's on; `printing`,
 * once that call is done, is which PDF of how many is being printed.
 */
export interface PdfStep {
    kind: 'messages' | 'whatsapp';
    part: number;
    parts: number;
    printing?: {
        file: number;
        files: number;
    };
}
export interface PdfExportResult {
    files: string[];
    message_count: number;
    /** Conversations split into several PDFs; empty when every PDF fit in one file. */
    splits: PdfSplit[];
    /** How many records the engine says it saved (notes, calls, page visits), when it says. */
    count?: number;
    /** Where export_person copied a person's photos and files (it's given media_dir). */
    media_folder?: string;
    /** export_person: how many files were copied, weren't in the backup, or couldn't be copied. */
    media?: {
        copied: number;
        not_in_backup: number;
        failed: number;
    };
    /** export_person: the parts that couldn't be read (e.g. WhatsApp), in plain words, by kind. */
    errors?: Record<string, string>;
}
/**
 * The limits above, read each time a PDF is made. Tests lower them on their own copy of
 * this module, so they can check a limit with small files (a 1.5 GB test file isn't
 * sparse on Windows: it would really take the space).
 */
export declare const PDF_LIMITS: {
    pageChars: number;
    pageBytes: number;
    pictureBytes: number;
};
/**
 * Delete temporary folders left behind by an export that never finished (for
 * example, the app was quit mid-export). They hold copies of message photos,
 * so they shouldn't linger. Call once at startup.
 */
export declare function removeStaleStagingDirs(maxAgeMs?: number): void;
/**
 * Run an engine export as PDF. `params` are the same as for the HTML export;
 * `params.output_dir` is where the PDFs go. A conversation too big for one
 * file is saved as several, one engine call each (planJobs). `onStep` hears
 * which of them it's on, and when each is printed.
 */
export declare function exportMessagesPdf(sidecar: Sidecar, method: PdfExportMethod, params: any, onStep?: (step: PdfStep) => void): Promise<PdfExportResult>;
export { safeBaseName };
/**
 * Print a page the window built (the Timeline, saved as a PDF) to
 * `<outputDir>/<baseName>.pdf`, or "<baseName> (2).pdf" when that exists. The
 * page is printed exactly as the engine's are: in the hidden window with no
 * JavaScript, no network and no files outside its own staging folder, which
 * is deleted afterwards.
 */
export declare function exportHtmlToPdf(html: unknown, outputDir: unknown, baseName: unknown): Promise<{
    file: string;
}>;
