import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Code2, Heart, Image as ImageIcon, Lock, MessageCircle, Pause, Phone, Play, StickyNote, Voicemail } from 'lucide-react';
// A real app screenshot, from the website (Maren's made-up backup).
import homeShot from '../../../website/static/img/home/home-1200.webp';
import workshopPhoto from './story-photos/charles-workshop.jpg';
import drivePhoto from './story-photos/charles-drive.jpg';

/**
 * Charles's story, told while Back up my iPhone copies files. BackupFlow shows it once the copy
 * starts, not while the iPhone waits for its passcode.
 *
 * The arc (his outline, 2026-11-27): meet Charles → exactly what it can do → why you can trust it
 * (stays on your computer, open source) → why he made it, kept general (it started with "how do I
 * get my texts off my phone?") → the journal he found once the dots were connected → why it's
 * free → what people say after 18,000 downloads → who pays (he does; a second full-time job) → a
 * handshake deal he can't actually shake on, so he just trusts you: nothing to click, nothing
 * recorded → Say thanks (private, or quoted on the site without a name), signed. The real ask
 * still comes at the first save (PriceStep, "What's this worth to you?").
 *
 * A carousel: chapters cross-fade on their own, each up long enough to read, and after the last it
 * starts again for as long as the backup runs (people walk away during long backups). It pauses
 * while the pointer is over it, while OpenExtract isn't the window in front, and with its pause
 * button; Hide folds it away.
 *
 * Wording rules: every claim is something the app really does, with OpenExtract as the one doing
 * it, and no "all" or "everything" (photos kept only in iCloud and some voicemails aren't in a
 * backup; the app only goes online when asked). It never says how few people pay, which would make
 * not paying the norm. Figures as of 2026-11-27: downloads from GitHub's release counts (installers,
 * including Windows auto-updates), updates from git tags (31 since v0.1.0 in March), quotes from the
 * site's published thank-yous (openextract.app/api/thanks). Nothing here takes a payment, stores
 * anything or sends anything.
 */

type Media =
  | { kind: 'shot'; src: string; alt: string }
  | { kind: 'photo'; alt: string; src: string; focus?: string }
  | { kind: 'stats'; items: { big: string; small: string }[] }
  | { kind: 'quotes'; quotes: string[] }
  | { kind: 'lock' }
  | { kind: 'deal' }
  /** The Say thanks form, drawn small with its real wording (shared/Feedback.tsx). */
  | { kind: 'thanks' }
  /** Why it's free: the paywall other tools put in front of your data, and what OpenExtract does instead. */
  | { kind: 'free' }
  /** Bits from different apps that line up into one timeline (the journal chapter). */
  | { kind: 'chain' };

interface Chapter {
  id: string;
  name: string;
  title: string;
  body: string[];
  /** A checklist under the body (what it can do), then an outro line. */
  list?: string[];
  outro?: string;
  media: Media;
  signed?: boolean;
  /** Stays up at least this long (ms), for chapters that ask for something. */
  minMs?: number;
}

function chapters(): Chapter[] {
  return [
    {
      id: 'hello',
      name: 'Hello',
      title: "Hi, I'm Charles.",
      body: [
        "I'm the guy who makes OpenExtract. I live in Reno, Nevada, and I have two grown kids.",
        'I was a programmer for many years. I burned out on projects that were more about making money than helping people, so I left to make art.',
        'Now I make ceramics full time and volunteer building giant art installations.',
      ],
      media: { kind: 'photo', alt: 'Charles in a warehouse full of giant art installations', src: workshopPhoto, focus: '70% center' },
    },
    {
      id: 'can-do',
      name: 'What it does',
      title: 'What OpenExtract can do',
      body: [],
      list: [
        'Backs up your iPhone to your computer',
        'Gets your photos off your phone',
        'Searches your texts, notes and WhatsApp chats',
        'Plays back the voicemails in your backup',
        'Puts your texts, calls, photos and more on one timeline',
        'Exports what you need, as many times as you like',
      ],
      outro: 'There\'s more, and you can start as soon as this backup finishes.',
      media: { kind: 'shot', src: homeShot, alt: "OpenExtract's home screen for a backup" },
    },
    {
      id: 'private',
      name: 'Privacy',
      title: 'It stays on your computer.',
      body: [
        "Everything happens right here. There's no account to make, and nothing from your backup is sent anywhere.",
        'OpenExtract only goes online when you say so: to check for updates, or to send me a note.',
        "And you don't have to take my word for it. OpenExtract is open source: the code is public, so anyone can check what it does.",
      ],
      media: { kind: 'lock' },
    },
    {
      id: 'question',
      name: 'Why I made it',
      title: 'How do I get my texts off my phone?',
      body: [
        "That's the question it all started with. Maybe it's yours too.",
        'More than once in my life, I needed to get things off my phone, for a different reason each time. It was always frustrating, and harder than it should have been.',
        'So I started building a tool that made it easy.',
      ],
      media: { kind: 'photo', alt: 'Charles smiling in his car', src: drivePhoto, focus: '60% center' },
    },
    {
      id: 'journal',
      name: 'A journal',
      title: "The journal I didn't know I kept",
      body: [
        'Once I started connecting the dots between my texts, notes, photos, WhatsApp chats, voicemails, calls and web history, I realized I was no longer just building a data exporter.',
        'My iPhone held a journal of my life that I never knew I was keeping. I worked hard to make a program that could show it to me.',
        'It became something I rely on, so I wanted to share it.',
      ],
      media: { kind: 'chain' },
      minMs: 17000,
    },
    {
      id: 'free',
      name: 'Why free',
      title: "Why it's free",
      body: [
        'Other extraction software frustrated me too many times: trials, paywalls, and a price that showed up right when I needed my data.',
        "I believe your privacy should be protected, so you don't even have to make an account. I believe in being open, so the code is public.",
        'And I wanted to get this into as many hands as I could. Free is a good way to do that.',
      ],
      media: { kind: 'free' },
      minMs: 17000,
    },
    {
      id: 'people-say',
      name: 'What people say',
      title: '18,000 downloads later',
      body: [
        "Here's what people are saying. Every week, someone writes to tell me what OpenExtract got back for them.",
      ],
      // From the site's published thank-yous (openextract.app/api/thanks, 2026-11-27), typos and
      // all; "…" where a sentence is cut. Shown three at a time, in this order.
      media: {
        kind: 'quotes',
        quotes: [
          'Recovered sentimental voicemails from my passed Dad. Thank you so much, this means a lot…',
          "Made a backup, and thanks to OpenExtract I could retrieve it easily. Otherwise years of photo's would've been gone :)",
          "Thanks. If this works out i'll buy you a beverage of your choice",

          "I just recovered thousands of messages from my dad's 14-year-old iPhone 4S (running iOS 9.3.6).",
          'OpenExtract is exactly the feature WhatsApp was missing!',
          'i am crying - thank you so much',

          'OpenExtract gave me an incredible peace of mind, and sense of safety today. Very, very, very grateful.',
          '…with your application it worked, by the first try... thanks you are a great human.',
          'This program was a lifesaver, thank you so much!',

          'My mother passed away last December and I am downloading the text conversations we had with her the previous year. Its a keepsake.',
          "I grabbed contacts from a backup of a currently inoperable phone and OpenExtract didn't charge me like iMazing wanted to do.",
          'This worked PERFECTLY!',

          'Thanks for your help ! I wanted to keep my messages from a friend who passed away recently !',
          "So so so thankful for this. I had an update go wrong on my Iphone 14 Pro Max and thought I'd lost some very important informaton in my Notes. Bless you for this",
          'thanks man you save me',
        ],
      },
      minMs: 18000,
    },
    {
      id: 'who-pays',
      name: 'Who pays',
      title: 'Who pays for it? I do.',
      body: [
        'OpenExtract has become a second full-time job, next to my ceramics.',
        "It's paid for with my time, and by the people who chip in when it helps them.",
      ],
      // No pay-rate figure here on purpose: saying how few pay makes not paying the norm.
      media: {
        kind: 'stats',
        items: [
          { big: '18,000', small: 'downloads' },
          { big: '31', small: 'updates since March' },
        ],
      },
    },
    {
      id: 'handshake',
      name: 'A handshake',
      title: 'Can we shake on it?',
      body: [
        "I don't like how most software makes you pay, for a lot of reasons, so I'm trying a handshake deal instead.",
        "You can have all of it, with nothing locked. If it works and you get what you needed, you'll pay what it was worth to you, if you can.",
        "But I can't shake your hand, and I won't try to find out who you are. So I'll just trust you.",
        "You have the phone, the computer, and all the time and effort I've put into making this the best I can.",
      ],
      media: { kind: 'deal' },
      minMs: 20000,
    },
    {
      id: 'thanks',
      name: 'Say thanks',
      title: 'A thank-you means a lot to me.',
      body: [
        "If OpenExtract helped you, tell me. There's a Say thanks button in Settings, and you'll often see one after you save something.",
        'Your note comes straight to me and stays private, unless you tick the box. Then it may be quoted on openextract.app, without your name.',
      ],
      media: { kind: 'thanks' },
      signed: true,
    },
  ];
}

// Long enough to read at a relaxed pace: about 0.28 s a word, 8 to 16 seconds.
function readingTime(c: Chapter): number {
  const words = [c.title, ...c.body, ...(c.list ?? []), c.outro ?? ''].join(' ').split(/\s+/).length;
  return Math.max(c.minMs ?? 0, Math.min(16000, Math.max(8000, 3000 + words * 280)));
}

/** One good day's bits, each from a different app. Made up: no real person or event. */
const CHAIN_ITEMS = [
  { label: 'Voicemail', text: '0:32 · "Good news…"', time: '9:20 AM', color: '#c89a3a', Icon: Voicemail, scatter: { x: -80, y: 214, r: -7 } },
  { label: 'Call', text: 'Called back · 6 min', time: '9:24 AM', color: '#6f8f6f', Icon: Phone, scatter: { x: 118, y: 6, r: 5 } },
  { label: 'WhatsApp', text: '"I got the job!!"', time: '9:41 AM', color: '#2f8a7b', Icon: MessageCircle, scatter: { x: -70, y: 52, r: 4 } },
  { label: 'Photo', text: 'Dinner to celebrate', time: '7:30 PM', color: '#9a6a8a', Icon: ImageIcon, scatter: { x: 112, y: 246, r: -4 } },
  { label: 'Note', text: 'Questions for day one', time: '10:05 PM', color: '#5f86a0', Icon: StickyNote, scatter: { x: 16, y: 134, r: -3 } },
];
const CHAIN_ROW = 58;

/**
 * Scattered bits from five apps slide into one timeline, a thread joins them, and a line says it
 * finally makes sense. Plays each time the chapter comes up; still (the end state) when the
 * system asks for less motion.
 */
function ChainPanel({ active }: { active: boolean }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) { setPhase(0); return; }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setPhase(3); return; }
    const timers = [700, 1800, 2500].map((ms, i) => window.setTimeout(() => setPhase(i + 1), ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active]);
  const lined = phase >= 1;
  return (
    <div
      className="relative h-full rounded-xl bg-sand border border-rule overflow-hidden"
      role="img"
      aria-label="A voicemail, a call, a WhatsApp message, a photo and a note, each from a different app, line up into one timeline of a day."
    >
      <p className="absolute top-4 inset-x-0 text-center text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
        {lined ? 'One timeline' : 'Five apps, five places'}
      </p>
      <div className="absolute left-1/2 top-12 -translate-x-1/2 w-[340px] h-[280px]">
        <div
          className="absolute left-[11px] top-6 w-0.5 bg-accent origin-top transition-transform duration-700 ease-out"
          style={{ height: CHAIN_ROW * (CHAIN_ITEMS.length - 1), transform: `scaleY(${phase >= 2 ? 1 : 0})` }}
        />
        {CHAIN_ITEMS.map((item, i) => {
          const finalTop = i * CHAIN_ROW;
          const { x, y, r } = item.scatter;
          const transform = lined ? 'translate(0px, 0px) rotate(0deg)' : `translate(${x - 32}px, ${y - finalTop}px) rotate(${r}deg)`;
          return (
            <div
              key={item.label}
              className={`absolute left-8 w-[300px] ${phase === 0 ? '' : 'transition-transform duration-[900ms] ease-in-out'}`}
              style={{ top: finalTop, transform, transitionDelay: phase === 1 ? `${i * 80}ms` : '0ms' }}
            >
              <span
                className={`absolute w-2.5 h-2.5 rounded-full ring-2 ring-sand transition-opacity duration-300 ${phase >= 2 ? 'opacity-100' : 'opacity-0'}`}
                style={{ left: -25, top: 19, background: item.color }}
              />
              <div className="flex items-center gap-2.5 h-12 px-3 rounded-lg border border-rule bg-surface shadow-[0_4px_12px_rgba(30,26,22,0.08)]">
                <span className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: `${item.color}22`, color: item.color }}>
                  <item.Icon size={15} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: item.color }}>{item.label}</div>
                  <div className="text-[13px] text-text-primary truncate">{item.text}</div>
                </div>
                <span className="text-[11px] text-text-tertiary tabular-nums">{item.time}</span>
              </div>
            </div>
          );
        })}
      </div>
      <p className={`absolute bottom-5 inset-x-0 text-center font-serif text-[18px] text-text-primary transition-opacity duration-500 ${phase >= 3 ? 'opacity-100' : 'opacity-0'}`}>
        Side by side, the whole day comes back.
      </p>
    </div>
  );
}

const QUOTES_PER_SET = 3;
const QUOTE_SET_MS = 6000;

/**
 * Published thank-yous, three at a time. While the chapter is up and the story is playing, the
 * next three fade in every few seconds; the panel stays mounted, so the next pass through the
 * story picks up where this one stopped.
 */
function QuotesPanel({ quotes, playing }: { quotes: string[]; playing: boolean }) {
  const sets: string[][] = [];
  for (let i = 0; i < quotes.length; i += QUOTES_PER_SET) sets.push(quotes.slice(i, i + QUOTES_PER_SET));
  const [n, setN] = useState(0);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!playing || sets.length < 2) return;
    let swap: number | undefined;
    const timer = window.setInterval(() => {
      setVisible(false);
      swap = window.setTimeout(() => {
        swap = undefined;
        setN((x) => (x + 1) % sets.length);
        setVisible(true);
      }, 350);
    }, QUOTE_SET_MS);
    return () => {
      window.clearInterval(timer);
      // Paused mid-fade: finish the swap so the panel is never left blank.
      if (swap !== undefined) {
        window.clearTimeout(swap);
        setN((x) => (x + 1) % sets.length);
        setVisible(true);
      }
    };
  }, [playing, sets.length]);
  const set = sets[n % sets.length] ?? [];
  return (
    <div className="relative h-full rounded-xl bg-sand border border-rule">
      <div className={`h-full flex flex-col justify-center gap-3 px-7 pb-6 transition-opacity duration-300 motion-reduce:transition-none ${visible ? 'opacity-100' : 'opacity-0'}`}>
        {set.map((q, i) => (
          <figure
            key={q}
            className={`max-w-[88%] px-4 py-3 rounded-xl bg-surface border border-rule shadow-[0_4px_14px_rgba(30,26,22,0.08)] ${i % 2 ? 'self-end' : 'self-start'}`}
          >
            <blockquote className="font-serif text-[15px] leading-snug text-text-primary">“{q}”</blockquote>
          </figure>
        ))}
      </div>
      <div className="absolute bottom-3.5 inset-x-7 flex items-center justify-between text-[11px] text-text-tertiary">
        <span>From Say thanks notes people said were OK to share</span>
        <span className="flex gap-1.5" aria-hidden="true">
          {sets.map((_, i) => (
            <span key={i} className={`w-1.5 h-1.5 rounded-full ${i === n % sets.length ? 'bg-accent' : 'bg-gray-300'}`} />
          ))}
        </span>
      </div>
    </div>
  );
}

function MediaPanel({ media, active, playing }: { media: Media; active: boolean; playing: boolean }) {
  if (media.kind === 'chain') return <ChainPanel active={active} />;
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
      <div className="h-full rounded-xl overflow-hidden border border-rule bg-sand">
        <img src={media.src} alt={media.alt} className="w-full h-full object-cover" style={{ objectPosition: media.focus ?? 'center' }} />
      </div>
    );
  }
  if (media.kind === 'stats') {
    return (
      <div className="h-full rounded-xl bg-sand border border-rule flex items-center justify-center gap-14 px-8">
        {media.items.map((s) => (
          <div key={s.small} className="text-center max-w-[220px]">
            <div className="font-serif text-[56px] leading-none text-accent">{s.big}</div>
            <div className="mt-3 text-sm text-text-secondary leading-snug">{s.small}</div>
          </div>
        ))}
      </div>
    );
  }
  if (media.kind === 'quotes') return <QuotesPanel quotes={media.quotes} playing={playing} />;
  if (media.kind === 'free') {
    // A made-up, generic "upgrade to export" dialog (no real product's look or price), with
    // OpenExtract's answer on top of it.
    return (
      <div
        className="relative h-full rounded-xl bg-sand border border-rule overflow-hidden"
        role="img"
        aria-label="A locked export dialog that says to upgrade, covered by a card that says OpenExtract is free: no trial or paywall, no account, and code anyone can read."
      >
        <div className="absolute left-10 top-12 w-[300px] rounded-xl bg-surface border border-rule shadow-[0_6px_18px_rgba(30,26,22,0.10)] p-5 -rotate-3 opacity-80 grayscale">
          <div className="text-sm font-medium text-text-primary">Export messages</div>
          <p className="mt-1 text-xs text-text-tertiary">3,214 messages ready to export</p>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-rule bg-base px-3 py-2.5 text-xs text-text-secondary">
            <Lock size={14} aria-hidden="true" /> Exporting is locked in the trial.
          </div>
          <div className="mt-4 flex gap-2">
            <span className="px-3 py-1.5 rounded-lg bg-gray-500 text-white text-xs font-medium">Upgrade to export</span>
            <span className="px-3 py-1.5 rounded-lg border border-rule text-xs text-text-tertiary">Cancel</span>
          </div>
        </div>
        <div className="absolute right-10 bottom-12 w-[270px] rounded-xl bg-surface border border-accent-line shadow-[0_14px_32px_rgba(30,26,22,0.18)] px-6 py-5 rotate-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-accent">OpenExtract</p>
          <p className="mt-1 font-serif text-[40px] leading-none text-text-primary">Free.</p>
          <ul className="mt-4 space-y-1.5 text-[13px] text-text-primary">
            {['No trial or paywall', 'No account', 'Code anyone can read'].map((t) => (
              <li key={t} className="flex items-center gap-2">
                <Check size={14} className="text-accent flex-shrink-0" aria-hidden="true" /> {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  if (media.kind === 'thanks') {
    return (
      <div className="h-full rounded-xl bg-sand border border-rule flex items-center justify-center px-10" aria-hidden="true">
        <div className="w-full max-w-[400px] rounded-xl bg-surface border border-rule shadow-[0_8px_24px_rgba(30,26,22,0.12)] p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Heart size={16} className="text-accent" /> Say thanks
          </div>
          <p className="mt-4 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Your message (optional)</p>
          <div className="mt-1.5 h-[72px] rounded-md border border-rule bg-base px-2.5 py-2 text-[13px] text-text-tertiary">
            What did OpenExtract help you do?
          </div>
          <div className="mt-3 flex items-start gap-2 text-xs text-text-secondary">
            <span className="mt-0.5 w-3.5 h-3.5 rounded-[3px] border border-gray-300 bg-surface flex-shrink-0" />
            <span>OK to quote what I wrote on openextract.app, without my name</span>
          </div>
          <div className="mt-4 flex justify-end">
            <span className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium">Send thanks</span>
          </div>
        </div>
      </div>
    );
  }
  if (media.kind === 'lock') {
    return (
      <div className="h-full rounded-xl bg-sand border border-rule flex flex-col items-center justify-center">
        <div className="w-20 h-20 rounded-full bg-accent-wash border border-accent-line flex items-center justify-center">
          <Lock size={34} className="text-accent" aria-hidden="true" />
        </div>
        <p className="mt-5 text-sm text-text-secondary">No account · No sign-in · Your backup stays here</p>
        <p className="mt-2 flex items-center gap-1.5 text-sm text-text-secondary">
          <Code2 size={15} className="text-accent" aria-hidden="true" /> Open source: anyone can read the code
        </p>
      </div>
    );
  }
  // The handshake card, the only kind left.
  return (
    <div className="h-full rounded-xl bg-sand border border-rule flex items-center justify-center px-10" aria-hidden="true">
      <div className="w-full max-w-[380px] rounded-lg bg-surface border border-rule shadow-[0_10px_28px_rgba(30,26,22,0.14)] px-7 py-8 -rotate-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">A handshake deal</p>
        <p className="mt-3 font-serif text-[21px] leading-snug text-text-primary">
          If OpenExtract gets me what I came for, I'll pay what it was worth to me, if I can.
        </p>
        <div className="mt-7 border-t border-dashed border-gray-300 pt-2 text-xs text-text-tertiary">
          Your word
        </div>
      </div>
    </div>
  );
}

export default function BackupStory() {
  const story = chapters();
  const [index, setIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [away, setAway] = useState(false); // OpenExtract isn't the window in front
  const [hidden, setHidden] = useState(false);
  const last = useRef(performance.now());

  const current = story[index];
  const duration = readingTime(current);
  const paused = userPaused || hovering || away;

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

  // After the last chapter, start again: it runs for as long as the backup does.
  useEffect(() => {
    if (elapsed < duration) return;
    setIndex((index + 1) % story.length);
    setElapsed(0);
  }, [elapsed, duration, index, story.length]);

  const go = (i: number) => {
    setIndex(((i % story.length) + story.length) % story.length);
    setElapsed(0);
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
                <MediaPanel media={c.media} active={i === index && !hidden} playing={i === index && !hidden && !paused} />
              </div>
              <div className="flex-1 min-w-0 flex flex-col py-2">
                <p className="text-[11px] font-medium uppercase tracking-wider text-accent">
                  {c.name} <span className="text-text-tertiary">· {i + 1} of {story.length}</span>
                </p>
                <h2 className="mt-2 font-serif text-[26px] leading-tight text-text-primary">{c.title}</h2>
                <div className="mt-3 space-y-2.5 text-[15px] text-text-secondary leading-relaxed">
                  {c.body.map((p) => <p key={p}>{p}</p>)}
                </div>
                {c.list && (
                  <ul className={`${c.body.length ? 'mt-3' : 'mt-4'} space-y-2 text-[15px] text-text-primary leading-snug`}>
                    {c.list.map((item) => (
                      <li key={item} className="flex items-start gap-2.5">
                        <Check size={16} className="mt-0.5 flex-shrink-0 text-accent" aria-hidden="true" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {c.outro && <p className="mt-3 text-[15px] text-text-secondary leading-relaxed">{c.outro}</p>}
                {c.signed && <p className="mt-3 text-[15px] text-text-primary">— Charles</p>}

                <div className="mt-auto flex items-center gap-2 pt-4">
                  <button
                    onClick={() => go(index - 1)}
                    className="w-8 h-8 rounded-full border border-rule flex items-center justify-center text-text-secondary hover:text-text-primary hover:border-gray-300"
                    aria-label="Previous chapter"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    onClick={() => setUserPaused((p) => !p)}
                    className="w-8 h-8 rounded-full border border-rule flex items-center justify-center text-text-secondary hover:text-text-primary hover:border-gray-300"
                    aria-label={userPaused ? 'Play' : 'Pause'}
                  >
                    {userPaused ? <Play size={14} /> : <Pause size={14} />}
                  </button>
                  <button
                    onClick={() => go(index + 1)}
                    className="w-8 h-8 rounded-full border border-rule flex items-center justify-center text-text-secondary hover:text-text-primary hover:border-gray-300"
                    aria-label="Next chapter"
                  >
                    <ChevronRight size={16} />
                  </button>
                  {paused && !userPaused && (
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
