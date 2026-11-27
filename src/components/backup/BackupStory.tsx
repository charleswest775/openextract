import { useEffect, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Lock, Pause, Play, RotateCcw } from 'lucide-react';
// Real app screenshots, from the website (Maren's made-up backup).
import homeShot from '../../../website/static/img/home/home-1200.webp';
import searchShot from '../../../website/static/img/home/search-1200.webp';
import peopleShot from '../../../website/static/img/home/people-list-1200.webp';
import saveShot from '../../../website/static/img/home/save-messages-600.webp';

/**
 * MOCKUP, not for merging: Charles's pitch, told while Back up my iPhone copies files.
 *
 * The arc: meet Charles (so people like him) → why it exists, against what this usually costs
 * → what you'll get and what to try first (so they get real value) → what other people say →
 * what it takes → the honest truth about who pays → what to expect at the first save, where
 * the real ask comes (PriceStep, "What's this worth to you?"). Nothing here takes a payment.
 *
 * Chapters cross-fade on their own, each up long enough to read. The story pauses while the
 * pointer is over it and while OpenExtract isn't the window in front, plays once, and stops on
 * the last chapter with Watch again. [[Double brackets]] mark words only Charles can write;
 * photos are placeholders that say which picture goes there. Figures are as of 2026-11-27:
 * releases from git tags, reports from OE- numbers in CHANGELOG.md, downloads and the share who pay from Charles, the iMazing price
 * from the site's iMazing alternatives page, quotes from the site's published thank-yous.
 */

type Media =
  | { kind: 'shot'; src: string; alt: string }
  | { kind: 'photo'; shot: string }
  | { kind: 'stats'; items: { big: string; small: string }[] }
  | { kind: 'quotes'; quotes: string[] }
  | { kind: 'lock' }
  | { kind: 'ai'; question: string };

interface Chapter {
  id: string;
  name: string;
  title: string;
  body: string[];
  media: Media;
  signed?: boolean;
}

function chapters(aiApp: string | null, shortcut: string): Chapter[] {
  const all: (Chapter | null)[] = [
    {
      id: 'hello',
      name: 'Hello',
      title: "Hi, I'm Charles.",
      body: [
        "I make OpenExtract, the free app that's backing up your iPhone right now.",
        '[[A line or two about you: where you live, what you do, who you do it for.]]',
      ],
      media: { kind: 'photo', shot: 'A warm portrait of you, looking at the camera' },
    },
    {
      id: 'why',
      name: 'Why',
      title: 'Why I made it',
      body: [
        'The best-known app for this charges $49.99 a year, and its trial saves just 25 messages.',
        "[[Your reason, in your words: the moment you needed something off an iPhone, and why you decided it should be free.]]",
      ],
      media: { kind: 'photo', shot: 'You at your desk, working on OpenExtract' },
    },
    {
      id: 'everything',
      name: "What you'll get",
      title: 'All of it, in one place',
      body: [
        'Messages and WhatsApp with their photos, your contacts, calls, voicemail, notes, calendar and more.',
        "You'll see all of it as soon as the backup is done.",
      ],
      media: { kind: 'shot', src: homeShot, alt: "OpenExtract's home screen for a backup" },
    },
    {
      id: 'search',
      name: 'Try this first',
      title: 'Search everything at once',
      body: [
        `Press ${shortcut} and type a word you remember.`,
        'Texts, WhatsApp, notes, calls and voicemail all come up together, and one click takes you to the moment.',
      ],
      media: { kind: 'shot', src: searchShot, alt: 'Search results for "birthday" across notes, messages and WhatsApp' },
    },
    {
      id: 'people',
      name: 'Then try this',
      title: 'Everything with one person',
      body: [
        'Open People and pick someone: every text, call and voicemail you shared, in order.',
        'Save everything saves it all at once. People use it for keepsakes, and for records they need to keep.',
      ],
      media: { kind: 'shot', src: peopleShot, alt: 'The People screen showing everything with one person' },
    },
    {
      id: 'save',
      name: 'No limits',
      title: 'Save as much as you want',
      body: [
        'Web page, PDF, spreadsheet or plain text, as many times as you like.',
        "Elsewhere, this is the part you pay for. Here, there's no trial and no paywall.",
      ],
      media: { kind: 'shot', src: saveShot, alt: 'The save window with web page, PDF, spreadsheet and plain text' },
    },
    aiApp ? {
      id: 'ai',
      name: `With ${aiApp}`,
      title: `Ask ${aiApp} about your backup`,
      body: [
        `${aiApp} is on this computer. With the OpenExtract AI add-on, it can answer questions about your backup and show you the messages it used.`,
        `What ${aiApp} reads to answer goes to ${aiApp}. 3 questions free, then $29 once for that iPhone, or $9 for a week.`,
      ],
      media: { kind: 'ai', question: 'When did Mom tell me about the move?' },
    } : null,
    {
      id: 'private',
      name: 'Privacy',
      title: 'It stays on this computer',
      body: [
        'No account, no sign-in, and OpenExtract never sends your messages or photos anywhere.',
      ],
      media: { kind: 'lock' },
    },
    {
      id: 'people-say',
      name: 'What people say',
      title: 'Why I keep going',
      body: [
        "Every week people write to tell me what OpenExtract got back for them. A dad's voicemails. A mom's last texts. Years of photos.",
        'Those notes mean more to me than I can say.',
      ],
      media: {
        kind: 'quotes',
        quotes: [
          'Recovered sentimental voicemails from my passed Dad. Thank you so much, this means a lot.',
          "I just recovered thousands of messages from my dad's 14-year-old iPhone 4S.",
          'OpenExtract gave me an incredible peace of mind, and sense of safety today.',
        ],
      },
    },
    {
      id: 'work',
      name: 'What it takes',
      title: 'What it takes',
      body: [
        'Apple changes how iPhones store things with almost every update, and every update can break something.',
        'So I test each release on real backups, on Mac and Windows, and fix what people report.',
      ],
      media: {
        kind: 'stats',
        items: [
          { big: '31', small: 'updates since March' },
          { big: '19', small: 'in the last month' },
          { big: '19', small: "changes from people's reports" },
        ],
      },
    },
    {
      id: 'truth',
      name: 'The honest truth',
      title: 'Who pays for it? I do.',
      body: [
        'OpenExtract is a gift to strangers. About 400 people download it every day, and fewer than 1 in 100 has ever paid anything.',
        'The rest is paid for with my time and energy.',
      ],
      media: {
        kind: 'stats',
        items: [
          { big: '~400', small: 'downloads a day' },
          { big: '<1%', small: 'have ever paid' },
        ],
      },
    },
    {
      id: 'ask',
      name: 'Be one of the few',
      title: 'Be one of the few.',
      body: [
        "The first time you save something, I'll ask what it's worth to you.",
        "If you can, please pay what it's worth: you're the reason it stays free for everyone else. If you truly can't, save it anyway. It's still yours.",
      ],
      media: { kind: 'photo', shot: 'A relaxed, smiling one for the sign-off' },
      signed: true,
    },
  ];
  return all.filter((c): c is Chapter => c !== null);
}

// Long enough to read at a relaxed pace: about 0.28 s a word, 8 to 16 seconds.
function readingTime(c: Chapter): number {
  const words = [c.title, ...c.body].join(' ').split(/\s+/).length;
  return Math.min(16000, Math.max(8000, 3000 + words * 280));
}

// [[...]] marks words only Charles can write: shown highlighted so they stand out in the mockup.
function WithGaps({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/);
  return (
    <>
      {parts.map((part, i) => part.startsWith('[[')
        ? <mark key={i} className="bg-accent-wash text-accent px-1 rounded border border-dashed border-accent-line">{part.slice(2, -2)}</mark>
        : <span key={i}>{part}</span>)}
    </>
  );
}

function MediaPanel({ media }: { media: Media }) {
  if (media.kind === 'shot') {
    return (
      <div className="h-full rounded-xl bg-sand border border-rule flex items-center justify-center p-4 overflow-hidden">
        <img
          src={media.src}
          alt={media.alt}
          className="max-w-full max-h-full rounded-lg border border-rule shadow-[0_8px_24px_rgba(30,26,22,0.14)]"
        />
      </div>
    );
  }
  if (media.kind === 'photo') {
    return (
      <div className="h-full rounded-xl border-2 border-dashed border-accent-line bg-accent-wash/40 flex flex-col items-center justify-center text-center px-8">
        <Camera size={28} className="text-accent mb-3" aria-hidden="true" />
        <p className="text-sm font-medium text-text-primary">Your photo</p>
        <p className="text-xs text-text-secondary mt-1">{media.shot}</p>
      </div>
    );
  }
  if (media.kind === 'stats') {
    return (
      <div className="h-full rounded-xl bg-sand border border-rule flex items-center justify-center gap-10 px-8">
        {media.items.map((s) => (
          <div key={s.small} className="text-center max-w-[150px]">
            <div className="font-serif text-[56px] leading-none text-accent">{s.big}</div>
            <div className="mt-3 text-sm text-text-secondary leading-snug">{s.small}</div>
          </div>
        ))}
      </div>
    );
  }
  if (media.kind === 'quotes') {
    return (
      <div className="h-full rounded-xl bg-sand border border-rule flex flex-col justify-center gap-3 px-7">
        {media.quotes.map((q, i) => (
          <figure
            key={q}
            className={`max-w-[88%] px-4 py-3 rounded-xl bg-surface border border-rule shadow-[0_4px_14px_rgba(30,26,22,0.08)] ${i % 2 ? 'self-end' : 'self-start'}`}
          >
            <blockquote className="font-serif text-[15px] leading-snug text-text-primary">“{q}”</blockquote>
          </figure>
        ))}
      </div>
    );
  }
  if (media.kind === 'lock') {
    return (
      <div className="h-full rounded-xl bg-sand border border-rule flex flex-col items-center justify-center">
        <div className="w-20 h-20 rounded-full bg-accent-wash border border-accent-line flex items-center justify-center">
          <Lock size={34} className="text-accent" aria-hidden="true" />
        </div>
        <p className="mt-5 text-sm text-text-secondary">No account · No sign-in · Nothing sent</p>
      </div>
    );
  }
  return (
    <div className="h-full rounded-xl bg-sand border border-rule flex flex-col justify-center px-8 gap-3" aria-hidden="true">
      <div className="self-end max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-accent text-white text-sm">
        {media.question}
      </div>
      {/* Stands for the AI's answer without making one up */}
      <div className="self-start w-[78%] px-4 py-3.5 rounded-2xl rounded-bl-md bg-surface border border-rule space-y-2">
        <div className="h-2 rounded bg-gray-200 w-[92%]" />
        <div className="h-2 rounded bg-gray-200 w-[80%]" />
        <div className="h-2 rounded bg-gray-200 w-[55%]" />
        <div className="flex gap-1.5 pt-1.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-wash text-accent">message</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-wash text-accent">message</span>
        </div>
      </div>
    </div>
  );
}

export default function BackupStory({ aiApp = null }: { aiApp?: string | null }) {
  const shortcut = window.openextract?.platform === 'darwin' ? '⌘K' : 'Ctrl+K';
  const story = chapters(aiApp, shortcut);
  const [index, setIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [away, setAway] = useState(false); // OpenExtract isn't the window in front
  const [finished, setFinished] = useState(false);
  const [hidden, setHidden] = useState(false);
  const last = useRef(performance.now());

  const current = story[index];
  const duration = readingTime(current);
  const paused = userPaused || hovering || away || finished;

  useEffect(() => {
    const onBlur = () => setAway(true);
    const onFocus = () => setAway(false);
    const onVisibility = () => setAway(document.visibilityState === 'hidden');
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    last.current = performance.now();
    if (paused) return;
    const timer = setInterval(() => {
      const now = performance.now();
      const step = now - last.current;
      last.current = now;
      setElapsed((e) => e + step);
    }, 100);
    return () => clearInterval(timer);
  }, [paused, index]);

  useEffect(() => {
    if (elapsed < duration) return;
    if (index < story.length - 1) {
      setIndex(index + 1);
      setElapsed(0);
    } else {
      setElapsed(duration);
      setFinished(true);
    }
  }, [elapsed, duration, index, story.length]);

  const go = (i: number) => {
    setIndex(Math.max(0, Math.min(story.length - 1, i)));
    setElapsed(0);
    setFinished(false);
  };
  const replay = () => {
    go(0);
    setUserPaused(false);
  };

  if (hidden) {
    return (
      <button onClick={() => setHidden(false)} className="text-xs text-text-tertiary hover:text-text-primary hover:underline">
        Show the story again
      </button>
    );
  }

  return (
    <section
      className="mt-2"
      aria-label="While you wait"
      data-backup-story
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Where you are: one bar a chapter, the current one fills as it plays */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 flex gap-1.5">
          {story.map((c, i) => (
            <button
              key={c.id}
              onClick={() => go(i)}
              className="flex-1 py-1.5 group"
              aria-label={`Chapter ${i + 1}: ${c.name}`}
              aria-current={i === index ? 'step' : undefined}
              title={c.name}
            >
              <span className="block h-1 rounded-full bg-gray-200 overflow-hidden group-hover:bg-gray-300">
                <span
                  className="block h-full bg-accent rounded-full"
                  style={{ width: i < index ? '100%' : i === index ? `${Math.min(100, (elapsed / duration) * 100)}%` : '0%' }}
                />
              </span>
            </button>
          ))}
        </div>
        <button onClick={() => setHidden(true)} className="text-xs text-text-tertiary hover:text-text-primary" title="Hide the story">
          Hide
        </button>
      </div>

      <div className="relative h-[400px]">
        {story.map((c, i) => {
          // Out first, then in: the old chapter fades in 200 ms, the new one starts as it ends,
          // so two chapters' text never overlap.
          const state = i === index
            ? 'opacity-100 translate-x-0 duration-500 delay-200'
            : `opacity-0 duration-200 ${i < index ? '-translate-x-6' : 'translate-x-6'}`;
          return (
            <div
              key={c.id}
              className={`absolute inset-0 flex gap-8 transition-all ease-out motion-reduce:transition-opacity motion-reduce:translate-x-0 ${state} ${i === index ? '' : 'pointer-events-none'}`}
              aria-hidden={i !== index}
              data-chapter={c.id}
            >
              <div className="w-[56%] flex-shrink-0">
                <MediaPanel media={c.media} />
              </div>
              <div className="flex-1 min-w-0 flex flex-col py-2">
                <p className="text-[11px] font-medium uppercase tracking-wider text-accent">
                  {c.name} <span className="text-text-tertiary">· {i + 1} of {story.length}</span>
                </p>
                <h2 className="mt-2 font-serif text-[26px] leading-tight text-text-primary">{c.title}</h2>
                <div className="mt-3 space-y-2.5 text-[15px] text-text-secondary leading-relaxed">
                  {c.body.map((p) => <p key={p}><WithGaps text={p} /></p>)}
                </div>
                {c.signed && <p className="mt-3 text-[15px] text-text-primary">— Charles</p>}

                <div className="mt-auto flex items-center gap-2 pt-4">
                  <button
                    onClick={() => go(index - 1)}
                    disabled={index === 0}
                    className="w-8 h-8 rounded-full border border-rule flex items-center justify-center text-text-secondary hover:text-text-primary hover:border-gray-300 disabled:opacity-40"
                    aria-label="Previous chapter"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  {finished ? (
                    <button onClick={replay} className="h-8 px-3 rounded-full border border-rule flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary hover:border-gray-300">
                      <RotateCcw size={14} /> Watch again
                    </button>
                  ) : (
                    <button
                      onClick={() => setUserPaused((p) => !p)}
                      className="w-8 h-8 rounded-full border border-rule flex items-center justify-center text-text-secondary hover:text-text-primary hover:border-gray-300"
                      aria-label={userPaused ? 'Play' : 'Pause'}
                    >
                      {userPaused ? <Play size={14} /> : <Pause size={14} />}
                    </button>
                  )}
                  <button
                    onClick={() => go(index + 1)}
                    disabled={index === story.length - 1}
                    className="w-8 h-8 rounded-full border border-rule flex items-center justify-center text-text-secondary hover:text-text-primary hover:border-gray-300 disabled:opacity-40"
                    aria-label="Next chapter"
                  >
                    <ChevronRight size={16} />
                  </button>
                  {paused && !finished && !userPaused && (
                    <span className="ml-2 text-[11px] text-text-tertiary">{away ? 'Paused while OpenExtract is in the background' : 'Paused'}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
