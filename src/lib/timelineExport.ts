import { TimelineEntry } from '../types/timeline';
import { formatDate, formatTime, formatDateTime, formatDuration } from './dates';

export type ExportFormat = 'html' | 'md' | 'csv';

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeCsv(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function entryDescription(e: TimelineEntry): string {
  switch (e.type) {
    case 'message': {
      const m = e.message!;
      const dir = m.isFromMe ? 'Sent' : 'Received';
      const text = m.text || (m.messageType === 'attachment' ? '[Attachment]' : m.messageType === 'audio' ? '[Audio message]' : '[No text]');
      return `${dir}: ${text}`;
    }
    case 'call': {
      const c = e.call!;
      const parts = [
        c.direction === 'incoming' ? 'Incoming' : 'Outgoing',
        c.status === 'missed' ? 'Missed' : c.status === 'answered' ? 'Answered' : c.status,
      ];
      if (c.duration > 0) parts.push(formatDuration(c.duration));
      return parts.join(' - ');
    }
    case 'photo': {
      const p = e.photo!;
      const kind = p.kind === 'video' ? 'Video' : p.kind === 'live_photo' ? 'Live Photo' : p.kind === 'screenshot' ? 'Screenshot' : 'Photo';
      const dims = p.width && p.height ? ` (${p.width}x${p.height})` : '';
      const dur = p.duration > 0 ? ` ${formatDuration(p.duration)}` : '';
      return `[${kind}] ${p.filename}${dims}${dur}`;
    }
    case 'voicemail': {
      const v = e.voicemail!;
      const parts = [`[Voicemail] ${formatDuration(v.duration)}`];
      if (v.transcript) parts.push(`"${v.transcript}"`);
      return parts.join(' - ');
    }
    case 'note': {
      const n = e.note!;
      const preview = n.bodyPreview ? ` - ${n.bodyPreview}` : '';
      return `${n.title}${preview}`;
    }
    case 'browser': {
      const b = e.browser!;
      return `[${b.browserName === 'firefox' ? 'Firefox' : 'Safari'}] ${b.title || b.domain} (${b.url})`;
    }
    default:
      return '';
  }
}

function entryContact(e: TimelineEntry): string {
  if (e.type === 'message' && e.message) {
    return e.message.conversationName || e.contactName || e.contactIdentifier || '';
  }
  return e.contactName || e.contactIdentifier || '';
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function toCsv(entries: TimelineEntry[]): string {
  const header = 'Date,Time,Type,Contact,Description';
  const rows = entries.map(e => {
    return [
      escapeCsv(formatDate(e.timestamp) || ''),
      escapeCsv(formatTime(e.timestamp) || ''),
      escapeCsv(e.type),
      escapeCsv(entryContact(e)),
      escapeCsv(entryDescription(e)),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function toMarkdown(entries: TimelineEntry[]): string {
  const lines: string[] = ['# Timeline Export', ''];

  // Group by day
  let lastDate = '';
  for (const e of entries) {
    const d = formatDate(e.timestamp) || 'Unknown date';
    if (d !== lastDate) {
      lastDate = d;
      lines.push(`## ${d}`, '');
    }

    const time = formatTime(e.timestamp) || '--:--';
    const typeLabel = e.type.charAt(0).toUpperCase() + e.type.slice(1);
    const contact = entryContact(e);
    const contactStr = contact ? ` | **${contact}**` : '';

    lines.push(`- \`${time}\` **${typeLabel}**${contactStr}`);
    lines.push(`  ${entryDescription(e)}`);
    lines.push('');
  }

  lines.push('---', `*Exported ${entries.length.toLocaleString()} entries on ${new Date().toLocaleDateString()}*`);
  return lines.join('\n');
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function toHtml(entries: TimelineEntry[]): string {
  const TYPE_COLORS: Record<string, string> = {
    message: '#007AFF', call: '#30d158', photo: '#AF52DE',
    voicemail: '#ff9f0a', note: '#5AC8FA', browser: '#34C759',
  };

  let body = '';
  let lastDate = '';

  for (const e of entries) {
    const d = formatDate(e.timestamp) || 'Unknown date';
    if (d !== lastDate) {
      lastDate = d;
      body += `<h2 style="margin:24px 0 8px;border-bottom:1px solid #e0e0e0;padding-bottom:4px;font-size:16px">${escapeHtml(d)}</h2>\n`;
    }

    const time = formatTime(e.timestamp) || '--:--';
    const color = TYPE_COLORS[e.type] || '#888';
    const typeLabel = e.type.charAt(0).toUpperCase() + e.type.slice(1);
    const contact = entryContact(e);
    const contactHtml = contact ? ` &mdash; <strong>${escapeHtml(contact)}</strong>` : '';

    body += `<div style="margin:4px 0;padding:6px 10px;border-left:3px solid ${color};background:#fafafa;border-radius:4px;font-size:13px">`;
    body += `<span style="color:#888;font-size:11px">${escapeHtml(time)}</span> `;
    body += `<span style="background:${color};color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:0.03em">${escapeHtml(typeLabel)}</span>`;
    body += contactHtml;
    body += `<div style="margin-top:2px">${escapeHtml(entryDescription(e))}</div>`;
    body += `</div>\n`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Timeline Export</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #222; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { font-size: 12px; color: #888; margin-bottom: 16px; }
</style>
</head>
<body>
<h1>Timeline Export</h1>
<div class="meta">${entries.length.toLocaleString()} entries &middot; Exported ${escapeHtml(new Date().toLocaleDateString())}</div>
${body}
</body>
</html>`;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function formatTimeline(entries: TimelineEntry[], format: ExportFormat): string {
  switch (format) {
    case 'csv': return toCsv(entries);
    case 'md': return toMarkdown(entries);
    case 'html': return toHtml(entries);
  }
}

export const FORMAT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  html: { name: 'HTML Document', extensions: ['html'] },
  md: { name: 'Markdown', extensions: ['md'] },
  csv: { name: 'CSV Spreadsheet', extensions: ['csv'] },
};
