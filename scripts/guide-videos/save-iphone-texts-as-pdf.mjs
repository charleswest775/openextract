// The steps of /videos/save-iphone-texts-as-pdf, the video for the
// /use-cases/export-imessage-to-pdf guide. Record it with:
//   node scripts/record-guide-video.mjs scripts/guide-videos/save-iphone-texts-as-pdf.mjs \
//     --backup <a backupgen maren-ios26-encrypted UDID folder>
// What each action does is in scripts/guide-videos/README.md.
export default {
  slug: 'save-iphone-texts-as-pdf',
  title: 'Save iPhone text messages as a PDF',
  steps: [
    {
      card: { title: 'Save iPhone text messages\n*as a PDF*', sub: 'Free, with OpenExtract · Windows, Mac and Linux' },
      ms: 4500,
      say: 'How to save an iPhone text conversation as a PDF with OpenExtract, free on Windows, Mac and Linux.',
      chapter: 'Open the backup',
    },
    {
      caption: 'OpenExtract lists the backups on your computer. Click Open.',
      say: "OpenExtract's start screen lists the iPhone backups it finds on your computer. Click Open next to yours.",
      do: [
        ['pause', 2000],
        ['click', { text: "Maren's iPhone", at: 'Open' }],
        ['waitFor', { css: 'input[type=password]' }],
        ['pause', 600],
      ],
    },
    {
      caption: 'If the backup is encrypted, type its password',
      say: 'If the backup is encrypted, type the password you set for it, and click Unlock. It stays on your computer.',
      do: [
        ['type', { css: 'input[type=password]' }, 'test'],
        ['pause', 700],
        ['click', { text: 'Unlock' }],
        ['waitFor', { css: '.titlebar input[type=search]' }, { cut: true }],
        ['pause', 2200],
      ],
    },
    {
      caption: 'Click Messages',
      say: "The backup's home page shows what's in it. Click Messages.",
      chapter: 'Find the conversation',
      do: [
        ['click', { label: 'Messages' }],
        ['waitFor', { text: 'Save conversation' }],
        ['pause', 2200],
      ],
    },
    {
      caption: 'Click the conversation you want to save',
      say: 'Every conversation is listed, newest first. Click the one you want to save. It opens with its photos, dates and times.',
      do: [
        ['click', { text: 'Karin Lindqvist' }],
        ['pause', 1800],
        ['wheel', { point: [980, 560] }, -900, 2600],
        ['pause', 2500],
      ],
    },
    {
      caption: 'Click Save conversation',
      say: 'Click Save conversation, at the top right.',
      chapter: 'Save it as a PDF',
      do: [
        ['saveTo'],
        ['click', { text: 'Save conversation' }],
        ['waitFor', { css: '[role=dialog]' }],
        ['pause', 1600],
      ],
    },
    {
      caption: 'Readable document is the PDF. Click Save.',
      say: 'Readable document, the PDF, is already chosen. Click Save.',
      poster: true,
      do: [
        ['hover', { text: 'Readable document', within: '[role=dialog]', at: [0.84, 0.55] }, 2000],
        ['click', { text: 'Save', within: '[role=dialog]' }],
      ],
    },
    {
      caption: 'Pick a folder. The PDF is saved there.',
      say: 'Pick a folder on your computer. The PDF is saved there, named after the conversation.',
      do: [
        ['waitFor', { text: 'Saved your conversation' }, { cut: true }],
        ['pause', 3600],
      ],
    },
    {
      pdf: { pages: 3 },
      ms: 14000,
      caption: 'Your PDF: every message, with dates, times and photos',
      say: 'The PDF has the whole conversation: every message with its date and time, who sent it, and the photos.',
      chapter: 'The PDF',
    },
    {
      card: { title: 'OpenExtract is *free*\nand open source', sub: 'Windows · Mac · Linux · openextract.app' },
      ms: 5000,
      say: 'OpenExtract is free and open source, for Windows, Mac and Linux. Get it at openextract.app.',
    },
  ],
};
