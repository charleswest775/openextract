# OpenExtract UI Overhaul — Design Variants

> Four production-ready design systems. Pick one, then implement.

---

## Current State (What We're Replacing)

**Problems identified:**
- Inconsistent theming: BackupSelector/Messages/Notes are light (bg-gray-50, bg-white), Calls/Contacts are dark (#0f1115), Photos use gray-900
- Emoji icons in navigation (💬📷📞📋👤📝) — looks amateur
- Sidebar is 64px wide with emoji + 10px labels — minimal, but unpolished
- Header is a basic white bar with plain text
- No design token system — all colors are ad-hoc Tailwind classes
- No consistent typography scale, spacing rhythm, or component patterns
- Gradient text (`from-blue-400 to-purple-500`) used inconsistently (Calls/Contacts headers only)
- Hardcoded hex colors (#0f1115, #161920, #1f222b, #1a1d24, #252833) scattered across components

---

## Variant 1 — "Obsidian"

### A. Design Direction
A sophisticated full-dark theme inspired by Raycast, Linear, and 1Password 8. Deep near-black backgrounds with precise surface layering create depth without visual noise. An electric violet accent provides energy and brand identity. Every pixel communicates: this was built by people who care about craft.

### B. Design Token System

```css
:root {
  /* Backgrounds */
  --bg-base: #09090b;          /* zinc-950 — deepest layer */
  --bg-surface: #18181b;       /* zinc-900 — cards, panels */
  --bg-elevated: #27272a;      /* zinc-800 — hover states, raised elements */
  --bg-overlay: #3f3f46;       /* zinc-700 — dropdowns, tooltips */
  --bg-sidebar: #0c0c0f;       /* custom — sidebar background */
  --bg-sidebar-active: rgba(139, 92, 246, 0.12); /* violet ghost */

  /* Text */
  --text-primary: #fafafa;     /* zinc-50 */
  --text-secondary: #a1a1aa;   /* zinc-400 */
  --text-tertiary: #71717a;    /* zinc-500 */
  --text-accent: #a78bfa;      /* violet-400 */
  --text-on-accent: #ffffff;

  /* Borders */
  --border-subtle: #27272a;    /* zinc-800 */
  --border-default: #3f3f46;   /* zinc-700 */
  --border-strong: #52525b;    /* zinc-600 */
  --border-accent: rgba(139, 92, 246, 0.3);

  /* Accent */
  --accent: #8b5cf6;           /* violet-500 */
  --accent-hover: #7c3aed;     /* violet-600 */
  --accent-subtle: rgba(139, 92, 246, 0.1);
  --accent-glow: rgba(139, 92, 246, 0.25);

  /* Semantic */
  --success: #22c55e;
  --warning: #eab308;
  --error: #ef4444;
  --info: #3b82f6;

  /* Radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.5);
  --shadow-glow: 0 0 20px rgba(139,92,246,0.15);

  /* Font */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
}
```

### C. Key Visual Decisions

| Decision | Choice |
|----------|--------|
| Theme | Full dark — no light mode |
| Sidebar | 56px collapsed (icon) / 200px expanded (icon + label). Translucent active state with violet left border accent. Collapse toggle at bottom. |
| Header | 48px height. bg-base with subtle bottom border. App name in text-primary, device info as a pill badge. Custom window controls (macOS traffic lights integrated). |
| Typography | Inter (Google Fonts). 13px base, 11px caption, 20px h2. font-weight: 500 for body, 600 for headings. |
| Card/surface | bg-surface with 1px border-subtle. On hover: border-default + shadow-sm. No gradients on surfaces. |
| Accent usage | Sidebar active indicator, primary buttons, links, active tab underlines, selected states only. Never on backgrounds. |
| Motion | 150ms ease-out for hovers. 200ms for panel transitions. No spring/bounce. Opacity + translate for enter/exit. |
| Icons | Lucide React (outline style, 18px, stroke-width 1.75). No emoji anywhere. |

### D. ASCII Mockup — Dashboard (Calls View)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●                                                                       │ ← custom titlebar
├────────┬─────────────────────────────────────────────────────────────────────┤
│  ☰     │  Call History                                    [🔍 Filter... ] [Export] │
│        │  1,247 calls extracted                                              │
│ ┌────┐ ├─────────────────────────────────────────────────────────────────────┤
│ │ 💬 │ │                                                                     │
│ │Msgs │ │  Type/Status    Contact              Date            Duration  Svc │
│ └────┘ │  ─────────────────────────────────────────────────────────────────  │
│ ┌────┐ │  ↙ Incoming     John Smith           Mar 12, 2026     3m 24s   📱  │
│ │ 📷 │ │                 +1 (555) 123-4567    2:15 PM                       │
│ │Photo│ │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ └────┘ │  ↳ Missed       Mom                  Mar 12, 2026     —        📱  │
│ ┌────┐ │                                      1:45 PM                       │
│ │ 📞 │ │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ │Voice│ │  ↗ Outgoing     Alice Chen           Mar 11, 2026     12m 5s   FT │
│ └────┘ │                                      6:30 PM                       │
│ ┌────┐ │                                                                     │
│ │ 📋 │ │                                                                     │
│ │Call │ │                                                                     │
│ └▓▓▓▓┘ │                   (▓ = violet active indicator on left edge)        │
│ ┌────┐ │─────────────────────────────────────────────────────────────────────│
│ │ 👤 │ │  Showing 1-100 of 1,247                              [Prev] [Next] │
│ │Cont │ └───────────────────────────────────────────────────────────────────┘
│ └────┘ │
│ ┌────┐ │
│ │ 📝 │ │
│ │Note │ │
│ └────┘ │
│        │
│  [◀▶]  │  ← expand/collapse toggle
└────────┘
```

**Color mapping in mockup:**
- Entire background: `--bg-base` (#09090b)
- Sidebar: `--bg-sidebar` (#0c0c0f) with 1px right border (--border-subtle)
- Active tab (Calls): `--bg-sidebar-active` with 3px violet left border
- Table container: `--bg-surface` (#18181b) with border-subtle, rounded-xl
- Table header row: `--bg-elevated` (#27272a)
- Table row hover: `--bg-elevated`
- Header area: same as `--bg-base` with bottom `--border-subtle`

### E. Tailwind Config Extension

```js
// tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Base palette
        base: '#09090b',
        surface: '#18181b',
        elevated: '#27272a',
        overlay: '#3f3f46',
        // Accent
        accent: {
          DEFAULT: '#8b5cf6',
          hover: '#7c3aed',
          subtle: 'rgba(139, 92, 246, 0.1)',
          glow: 'rgba(139, 92, 246, 0.25)',
        },
        // Sidebar
        sidebar: {
          DEFAULT: '#0c0c0f',
          active: 'rgba(139, 92, 246, 0.12)',
        },
        // Semantic
        'imessage-blue': '#007AFF',
        'imessage-green': '#34C759',
        'bubble-gray': '#3A3A3C',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'monospace'],
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,0.3)',
        md: '0 4px 12px rgba(0,0,0,0.4)',
        lg: '0 8px 24px rgba(0,0,0,0.5)',
        glow: '0 0 20px rgba(139,92,246,0.15)',
      },
      fontSize: {
        caption: ['11px', { lineHeight: '16px' }],
        body: ['13px', { lineHeight: '20px' }],
        subhead: ['15px', { lineHeight: '22px' }],
        title: ['20px', { lineHeight: '28px' }],
      },
    },
  },
  plugins: [],
};
```

### F. Component-Level Callouts

**1. Sidebar Navigation Item**
```
Default:  bg-transparent, icon #71717a (tertiary), no label visible in collapsed mode
Hover:    bg-elevated (#27272a), icon lightens to #a1a1aa
Active:   bg-sidebar-active (violet ghost), 3px solid violet left border,
          icon becomes #a78bfa (violet-400), label text #fafafa
          Smooth 150ms transition on all properties
```

**2. Data Table Row (Calls View)**
```
Default:  bg-surface (#18181b), text #a1a1aa secondary, 1px bottom border-subtle
Hover:    bg-elevated (#27272a), text shifts to #fafafa
          Left edge gets 2px accent border (subtle slide-in, 150ms)
Missed:   status text #ef4444, no background change
Active/selected: bg-accent-subtle, full accent left border
```

**3. Backup Selector Card**
```
Default:  bg-surface, 1px border-subtle, rounded-xl (16px)
          Device name: text-primary semibold
          Details (iOS, date): text-secondary
          Size badge: mono font, text-tertiary
Hover:    border-accent (violet border), shadow-glow, translate-y -1px
          Device name gains text-accent color
Encrypted badge: bg-warning/10 text-warning rounded-full pill
Click:    scale(0.98) for 100ms (micro-press feedback)
```

**4. Search Input (Global Pattern)**
```
bg-elevated (#27272a), 1px border-subtle, rounded-lg (12px)
Placeholder: text-tertiary
Focus: border-accent, shadow-glow, bg-surface
Icon: Lucide Search, 16px, text-tertiary → text-secondary on focus
150ms transition all
```

---

## Variant 2 — "Arctic"

### A. Design Direction
A pristine, minimal light theme inspired by Vercel's dashboard and Notion's clarity. Pure whites, cool gray hierarchy, and a single bold indigo accent. Generous whitespace and refined typography create an experience that feels like a $200/yr SaaS product — professional, focused, and quietly confident. Less is more.

### B. Design Token System

```css
:root {
  /* Backgrounds */
  --bg-base: #ffffff;
  --bg-surface: #f9fafb;        /* gray-50 */
  --bg-elevated: #f3f4f6;       /* gray-100 */
  --bg-overlay: #ffffff;
  --bg-sidebar: #fafbfc;
  --bg-sidebar-active: #eef2ff; /* indigo-50 */

  /* Text */
  --text-primary: #111827;      /* gray-900 */
  --text-secondary: #6b7280;    /* gray-500 */
  --text-tertiary: #9ca3af;     /* gray-400 */
  --text-accent: #4f46e5;       /* indigo-600 */
  --text-on-accent: #ffffff;

  /* Borders */
  --border-subtle: #f3f4f6;     /* gray-100 */
  --border-default: #e5e7eb;    /* gray-200 */
  --border-strong: #d1d5db;     /* gray-300 */
  --border-accent: #c7d2fe;     /* indigo-200 */

  /* Accent */
  --accent: #4f46e5;            /* indigo-600 */
  --accent-hover: #4338ca;      /* indigo-700 */
  --accent-subtle: #eef2ff;     /* indigo-50 */
  --accent-muted: #e0e7ff;      /* indigo-100 */

  /* Semantic */
  --success: #059669;           /* emerald-600 */
  --warning: #d97706;           /* amber-600 */
  --error: #dc2626;             /* red-600 */
  --info: #2563eb;              /* blue-600 */

  /* Radius */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.06);
  --shadow-lg: 0 4px 16px rgba(0,0,0,0.08);
  --shadow-ring: 0 0 0 3px rgba(79,70,229,0.12);

  /* Font */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}
```

### C. Key Visual Decisions

| Decision | Choice |
|----------|--------|
| Theme | Full light — clean white base |
| Sidebar | 220px expanded with icon + label. Subtle gray left border on active (not background fill). Minimal — almost invisible until interaction. |
| Header | 52px. White bg, single hairline bottom border (#e5e7eb). Wordmark left, device pill center-right, button right. Breathable. |
| Typography | Inter. 14px base. text-primary for headings (#111827), text-secondary for body (#6b7280). Letter-spacing -0.01em on headings for tightness. |
| Card/surface | bg-base (white) with 1px border-default (#e5e7eb). shadow-sm on hover. No color fills — borders do the work. |
| Accent usage | Indigo-600. Used for: active sidebar text, primary buttons, links, focus rings. Everything else is gray scale. |
| Motion | 120ms ease for hovers. 200ms for content transitions. Subtle opacity fades. No transforms on cards. |
| Icons | Lucide React, 20px, stroke-width 1.5, gray-400 default, gray-900 on active. |

### D. ASCII Mockup — Dashboard (Messages View)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  OpenExtract          iPhone 15 Pro · iOS 18.1                Change Backup  │
├──────────────────────┬───────────────────────────────────────────────────────┤
│                      │                                                       │
│   Messages        ← │  ┌─────────────────┐  ┌─────────────────────────────┐ │
│   Photos             │  │ 🔍 Search...     │  │  John Smith                 │ │
│   Voicemail          │  ├─────────────────┤  │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │ │
│   Calls              │  │                 │  │                             │ │
│   Contacts           │  │ ■ John Smith    │  │  Hey, are you coming to     │ │
│   Notes              │  │   Sure, see you │  │  the meetup tonight?        │ │
│                      │  │   2:15 PM       │  │                    2:14 PM  │ │
│                      │  │                 │  │                             │ │
│                      │  │   Alice Chen    │  │       Yeah, I'll be there!  │ │
│                      │  │   Photo         │  │       See you at 7          │ │
│                      │  │   1:30 PM       │  │                    2:15 PM  │ │
│                      │  │                 │  │                             │ │
│                      │  │   Mom           │  │                             │ │
│                      │  │   Call me when  │  │                             │ │
│                      │  │   11:20 AM      │  │                             │ │
│                      │  │                 │  │                             │ │
│                      │  │                 │  ├─────────────────────────────┤ │
│                      │  │                 │  │  3mo  6mo  1yr  Custom      │ │
│                      │  │                 │  │         [Export ▾]          │ │
│                      │  └─────────────────┘  └─────────────────────────────┘ │
└──────────────────────┴───────────────────────────────────────────────────────┘
```

**Color mapping:**
- Sidebar: `--bg-sidebar` (#fafbfc), right border `--border-default`
- Active item (Messages): text becomes `--text-accent` (indigo-600), 2px left indigo border, no bg fill
- Header: `--bg-base` (white) with bottom `--border-default`
- Conversation list: `--bg-base`, selected conversation gets `--accent-subtle` (#eef2ff) bg
- Chat area: `--bg-surface` (#f9fafb)
- Sent bubble: `--accent` (#4f46e5) bg with white text
- Received bubble: `--bg-base` (white) with `--border-default` border

### E. Tailwind Config Extension

```js
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#ffffff',
        surface: '#f9fafb',
        elevated: '#f3f4f6',
        accent: {
          DEFAULT: '#4f46e5',
          hover: '#4338ca',
          subtle: '#eef2ff',
          muted: '#e0e7ff',
        },
        sidebar: {
          DEFAULT: '#fafbfc',
          active: '#eef2ff',
        },
        'imessage-blue': '#4f46e5',  /* remap to match accent */
        'imessage-green': '#059669',
        'bubble-gray': '#f3f4f6',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,0.04)',
        md: '0 2px 8px rgba(0,0,0,0.06)',
        lg: '0 4px 16px rgba(0,0,0,0.08)',
        ring: '0 0 0 3px rgba(79,70,229,0.12)',
      },
      fontSize: {
        caption: ['11px', { lineHeight: '16px' }],
        body: ['14px', { lineHeight: '22px' }],
        subhead: ['15px', { lineHeight: '22px' }],
        title: ['20px', { lineHeight: '28px' }],
      },
    },
  },
  plugins: [],
};
```

### F. Component-Level Callouts

**1. Sidebar Navigation Item**
```
Default:  bg-transparent, icon gray-400, label gray-500, 14px, font-medium
          Padding: 8px 16px, gap-3 between icon and label
Hover:    icon → gray-600, label → gray-700 (no bg change — ghost hover)
Active:   2px left border indigo-600, icon → indigo-600, label → gray-900 font-semibold
          No background fill — the indigo border IS the indicator
          Transition: 120ms ease
```

**2. Data Table Row (Calls View)**
```
Default:  bg-base (white), text-secondary, bottom border 1px border-subtle
          Row height: 56px. Clean, airy spacing.
Hover:    bg-surface (#f9fafb) — barely visible tint
          No transforms, no shadows
Zebra:    none (hover is sufficient)
Missed call: text-error for status, rest unchanged
Header row: text-tertiary uppercase, 11px tracking-wider, bg-surface
```

**3. Backup Selector Card**
```
Default:  bg-base (white), 1px border-default (#e5e7eb), rounded-xl
          Clean 24px padding. Device name: 16px semibold text-primary
          Meta: 13px text-secondary. Size: mono, text-tertiary
Hover:    border-accent (#c7d2fe), shadow-md
          No color changes to text — border + shadow is enough
Encrypted badge: bg-amber-50 text-amber-700 border border-amber-200 rounded-full
Focus:    shadow-ring (indigo focus ring)
```

---

## Variant 3 — "Titanium"

### A. Design Direction
System-adaptive (follows OS light/dark preference). Inspired by macOS Sequoia, Apple Developer Tools, and native Mac apps. Uses the system font stack, translucent sidebar hints, and precise spacing on a 4pt grid. The goal: if you squint, it looks like it shipped with the Mac. Professional and invisible — the content is the UI.

### B. Design Token System

```css
/* Light mode (default) */
:root {
  --bg-base: #ffffff;
  --bg-surface: #f5f5f7;          /* Apple gray */
  --bg-elevated: #e8e8ed;
  --bg-sidebar: rgba(245, 245, 247, 0.85); /* translucent */
  --bg-sidebar-active: rgba(0, 0, 0, 0.06);

  --text-primary: #1d1d1f;
  --text-secondary: #6e6e73;       /* Apple secondary */
  --text-tertiary: #aeaeb2;
  --text-accent: #0071e3;          /* Apple blue */

  --border-subtle: rgba(0, 0, 0, 0.04);
  --border-default: rgba(0, 0, 0, 0.08);
  --border-strong: rgba(0, 0, 0, 0.14);

  --accent: #0071e3;
  --accent-hover: #0077ed;
  --accent-subtle: rgba(0, 113, 227, 0.08);

  --success: #30d158;
  --warning: #ff9f0a;
  --error: #ff3b30;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 14px;

  --shadow-sm: 0 0.5px 1px rgba(0,0,0,0.1);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.1);
  --shadow-lg: 0 4px 20px rgba(0,0,0,0.12);

  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', 'Menlo', 'Consolas', monospace;
  --font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  :root {
    --bg-base: #1c1c1e;
    --bg-surface: #2c2c2e;
    --bg-elevated: #3a3a3c;
    --bg-sidebar: rgba(28, 28, 30, 0.85);
    --bg-sidebar-active: rgba(255, 255, 255, 0.08);

    --text-primary: #f5f5f7;
    --text-secondary: #aeaeb2;
    --text-tertiary: #636366;

    --border-subtle: rgba(255, 255, 255, 0.04);
    --border-default: rgba(255, 255, 255, 0.08);
    --border-strong: rgba(255, 255, 255, 0.14);

    --accent-subtle: rgba(0, 113, 227, 0.15);
  }
}
```

### C. Key Visual Decisions

| Decision | Choice |
|----------|--------|
| Theme | System-adaptive. Respect `prefers-color-scheme`. |
| Sidebar | 180px. Semi-translucent (`backdrop-blur-xl`) with `--bg-sidebar`. Items have rounded-lg active bg like macOS. Compact 32px row height. |
| Header | 44px. Matches sidebar translucency. Title in `--font-display` at 13px -600 weight. No separator line — uses shadow instead. Feels like a native toolbar. |
| Typography | System font stack (SF Pro on Mac, Segoe UI on Windows). 13px base — Apple's standard body size. -0.003em tracking. |
| Card/surface | bg-surface with 0.5px borders (use `border-[0.5px]`). Rounded-lg (10px). Apple uses less radius than web convention. |
| Accent usage | Apple blue (#0071e3). Selection highlights, primary buttons, active sidebar. System-default for checkboxes/toggles. |
| Motion | 250ms ease-in-out (macOS standard curve). Sidebar item transitions use 200ms. Content fades at 300ms. |
| Icons | SF Symbols style — if not available, Lucide at 16px, stroke-width 1.5. Prefer filled icons for active states. |

### D. ASCII Mockup — Dashboard (Contacts View)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ● ● ●   OpenExtract     iPhone 15 Pro · iOS 18.1           Change Backup  │
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
├──────────────────┬───────────────────────────────────────────────────────────┤
│ (translucent bg) │  Contacts · 847                    [🔍 Find...        ]  │
│                  │                                                           │
│  💬 Messages     │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  📷 Photos       │  │  AS      │  │  BC      │  │  CD      │               │
│  📞 Voicemail    │  │ Alice    │  │ Bob      │  │ Carol    │               │
│  📋 Calls        │  │ Smith    │  │ Chen     │  │ Davis    │               │
│  ■ Contacts      │  │ Apple    │  │          │  │ Acme Inc │               │
│  📝 Notes        │  │          │  │ 555-0102 │  │          │               │
│                  │  │ 555-0101 │  │ bob@...  │  │ carol@.. │               │
│                  │  │ alice@.. │  │          │  │ 555-0103 │               │
│                  │  └──────────┘  └──────────┘  └──────────┘               │
│                  │                                                           │
│                  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│                  │  │  DE      │  │  EF      │  │  FG      │               │
│                  │  │ David    │  │ Emma     │  │ Frank    │               │
│                  │  │ Evans    │  │ Foster   │  │ Garcia   │               │
│                  │  │ ...      │  │ ...      │  │ ...      │               │
│                  │  └──────────┘  └──────────┘  └──────────┘               │
│                  ├───────────────────────────────────────────────────────────│
│                  │  1-50 of 847                                [◀] [▶]      │
└──────────────────┴───────────────────────────────────────────────────────────┘
```

**Color mapping:**
- Sidebar: translucent `--bg-sidebar` with `backdrop-blur(20px)`
- Active item (Contacts): rounded-lg `--bg-sidebar-active`, text goes `--text-primary`, icon filled
- Header: integrated with sidebar translucency, bottom shadow-sm instead of border
- Content: `--bg-base` (white in light, #1c1c1e in dark)
- Cards: `--bg-surface` with 0.5px `--border-default`, rounded-lg
- Avatar circle: `--accent` bg with white initial letter
- Count badge "847" in header: `--text-tertiary`, regular weight

### E. Tailwind Config Extension

```js
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'media',  /* follow OS preference */
  theme: {
    extend: {
      colors: {
        base: { DEFAULT: '#ffffff', dark: '#1c1c1e' },
        surface: { DEFAULT: '#f5f5f7', dark: '#2c2c2e' },
        elevated: { DEFAULT: '#e8e8ed', dark: '#3a3a3c' },
        accent: {
          DEFAULT: '#0071e3',
          hover: '#0077ed',
          subtle: 'rgba(0, 113, 227, 0.08)',
        },
        sidebar: {
          DEFAULT: 'rgba(245, 245, 247, 0.85)',
          active: 'rgba(0, 0, 0, 0.06)',
        },
        apple: {
          gray: '#f5f5f7',
          'gray-2': '#e8e8ed',
          'gray-3': '#d2d2d7',
          text: '#1d1d1f',
          'text-2': '#6e6e73',
          blue: '#0071e3',
          green: '#30d158',
          red: '#ff3b30',
          orange: '#ff9f0a',
        },
        'imessage-blue': '#007AFF',
        'imessage-green': '#34C759',
        'bubble-gray': { DEFAULT: '#e8e8ed', dark: '#3a3a3c' },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '10px',
        xl: '14px',
      },
      boxShadow: {
        sm: '0 0.5px 1px rgba(0,0,0,0.1)',
        md: '0 2px 8px rgba(0,0,0,0.1)',
        lg: '0 4px 20px rgba(0,0,0,0.12)',
        toolbar: '0 0.5px 0 rgba(0,0,0,0.1)',
      },
      backdropBlur: {
        sidebar: '20px',
      },
      fontSize: {
        caption: ['11px', { lineHeight: '14px', letterSpacing: '0.01em' }],
        body: ['13px', { lineHeight: '20px', letterSpacing: '-0.003em' }],
        subhead: ['15px', { lineHeight: '22px', letterSpacing: '-0.01em' }],
        title: ['20px', { lineHeight: '24px', letterSpacing: '-0.015em' }],
      },
      spacing: {
        /* 4pt grid helpers */
        '4.5': '18px',
        '7': '28px',
        '9': '36px',
        '11': '44px',
      },
    },
  },
  plugins: [],
};
```

### F. Component-Level Callouts

**1. Sidebar Navigation Item**
```
Default:  bg-transparent. Icon 16px gray (#6e6e73). Label 13px gray, font-normal.
          Padding: 6px 12px. Row height: 32px. rounded-md (8px).
Hover:    bg-black/4 (light) or bg-white/6 (dark). 200ms ease.
Active:   bg-black/6 (light) or bg-white/10 (dark). rounded-md.
          Icon becomes filled variant + accent blue.
          Label: text-primary, font-medium.
          Feels exactly like macOS Finder sidebar.
```

**2. Data Table Row (Calls View)**
```
Default:  bg-base, 0.5px bottom border (--border-subtle)
          13px body text. 44px row height (Apple HIG standard).
          Alternating rows: none (too noisy for Apple aesthetic)
Hover:    bg-accent-subtle (blue tint). 200ms.
Selected: bg-accent, text-white (full inversion, like macOS list selection)
Status icons: SF-style — circle.arrow.down.fill (incoming), arrow.up.right (outgoing)
Duration: mono font, text-tertiary
```

**3. Contact Card**
```
Default:  bg-surface, 0.5px border (--border-default), rounded-lg (10px)
          Avatar: 36px circle, accent-blue bg, white letter, SF Display weight
          Name: 15px subhead, text-primary, -0.01em tracking
          Org: 11px caption, text-secondary
          Details: 13px body, icon + label pairs
          Padding: 16px
Hover:    shadow-md, border-strong. 250ms ease-in-out.
          No color change — shadow creates lift.
Dark mode: bg-surface-dark (#2c2c2e), border rgba(255,255,255,0.08)
```

---

## Variant 4 — "Neon Forge"

### A. Design Direction
A bold, opinionated dark theme with warm amber/orange energy. Inspired by gaming dashboards, developer terminals, and cyberpunk UI aesthetics — but refined for professional use. Deep charcoal backgrounds with a warm amber accent that glows. Gradient borders on key surfaces. This variant says: "This isn't just a tool, it's an experience." It's the variant for users who want their software to have personality.

### B. Design Token System

```css
:root {
  /* Backgrounds */
  --bg-base: #0a0a0c;
  --bg-surface: #141418;
  --bg-elevated: #1e1e24;
  --bg-overlay: #28282f;
  --bg-sidebar: #0e0e12;
  --bg-sidebar-active: rgba(251, 146, 60, 0.08);

  /* Text */
  --text-primary: #eeeef0;
  --text-secondary: #8b8b96;
  --text-tertiary: #5c5c66;
  --text-accent: #fb923c;       /* orange-400 */
  --text-on-accent: #0a0a0c;

  /* Borders */
  --border-subtle: #1e1e24;
  --border-default: #2a2a32;
  --border-strong: #3a3a44;
  --border-accent: rgba(251, 146, 60, 0.25);
  --border-gradient-from: #fb923c;
  --border-gradient-to: #f97316;

  /* Accent */
  --accent: #fb923c;            /* orange-400 */
  --accent-hover: #f97316;      /* orange-500 */
  --accent-subtle: rgba(251, 146, 60, 0.06);
  --accent-glow: rgba(251, 146, 60, 0.2);

  /* Secondary accent */
  --accent-2: #38bdf8;          /* sky-400 — for informational highlights */

  /* Semantic */
  --success: #4ade80;
  --warning: #fbbf24;
  --error: #f87171;

  /* Radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;

  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.4);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.5);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.6);
  --shadow-glow: 0 0 24px rgba(251,146,60,0.12);
  --shadow-glow-strong: 0 0 40px rgba(251,146,60,0.2);

  /* Font */
  --font-sans: 'Space Grotesk', 'Inter', -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}
```

### C. Key Visual Decisions

| Decision | Choice |
|----------|--------|
| Theme | Full dark with warm undertones. No light mode — this is an identity choice. |
| Sidebar | 52px collapsed / 200px expanded. Thin top-to-bottom gradient line on right edge (amber→orange). Active item has amber left glow bar. |
| Header | 48px. bg-base. App name in Space Grotesk Bold with a subtle amber gradient. Device info in a terminal-style pill (`font-mono`, border-default`). |
| Typography | Space Grotesk (headings/nav) + Inter (body). A display typeface gives this variant its distinctive character. Mono for data/numbers. |
| Card/surface | bg-surface, 1px border-subtle. Featured cards get a 1px gradient border (amber→orange) on hover. Rounded-lg. |
| Accent usage | Amber/orange (#fb923c). Prominent — used for active states, primary actions, the logo, data highlights, and hover glow effects. Sky-blue (#38bdf8) as secondary accent for informational badges. |
| Motion | 200ms ease-out. Glow effects pulse subtly on hover (box-shadow transition). Cards lift 2px on hover with glow. Sidebar items slide-in with left border animation. |
| Icons | Lucide React, 18px, stroke-width 2. Slightly bolder than other variants — matches the bolder personality. |

### D. ASCII Mockup — Dashboard (Notes View)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ◇ OpenExtract       ┌──────────────────────┐             Change Backup     │
│                      │ iPhone 15 Pro · 18.1 │  ← mono pill                  │
│                      └──────────────────────┘                                │
├────────┬──────────────────────┬──────────────────────────────────────────────┤
│  ▊     │  🔍 Search notes...  │                                              │
│  ▊     ├──────────────────────┤  Meeting Notes — Q4 Planning                │
│ ┃█┃Msgs│                      │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─            │
│ ┃ ┃Phot│  ■ Meeting Notes     │  Created: Mar 10, 2026                      │
│ ┃ ┃Voic│    Q4 Planning       │  Modified: Mar 12, 2026                     │
│ ┃ ┃Call│    Mar 12             │                                              │
│ ┃ ┃Cont│                      │  The quarterly planning session covered     │
│ ┃█┃Note│    Shopping List      │  three main initiatives for the team:       │
│  ▊     │    Groceries          │                                              │
│  ▊     │    Mar 11             │  1. Migrate auth service to new provider    │
│  ▊     │                      │  2. Redesign onboarding flow                │
│  ▊     │    Travel Ideas       │  3. Performance audit on API layer          │
│  ▊     │    Summer 2026        │                                              │
│  ▊     │    Mar 8              │  Action items were assigned to...           │
│  ▊     │                      │                                              │
│  ▊     │                      │           [Export TXT] [Export PDF]          │
│  ▊ ◀▶  │                      │                                              │
├────────┴──────────────────────┴──────────────────────────────────────────────┤
│  ▊ = gradient accent line on sidebar right edge                              │
│  ┃█┃ = amber glow left bar on active tab                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### E. Tailwind Config Extension

```js
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0a0a0c',
        surface: '#141418',
        elevated: '#1e1e24',
        overlay: '#28282f',
        accent: {
          DEFAULT: '#fb923c',
          hover: '#f97316',
          subtle: 'rgba(251, 146, 60, 0.06)',
          glow: 'rgba(251, 146, 60, 0.2)',
        },
        'accent-2': '#38bdf8',
        sidebar: {
          DEFAULT: '#0e0e12',
          active: 'rgba(251, 146, 60, 0.08)',
        },
        'imessage-blue': '#38bdf8',
        'imessage-green': '#4ade80',
        'bubble-gray': '#1e1e24',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        sm: '0 1px 3px rgba(0,0,0,0.4)',
        md: '0 4px 12px rgba(0,0,0,0.5)',
        lg: '0 8px 32px rgba(0,0,0,0.6)',
        glow: '0 0 24px rgba(251,146,60,0.12)',
        'glow-strong': '0 0 40px rgba(251,146,60,0.2)',
      },
      backgroundImage: {
        'gradient-accent': 'linear-gradient(180deg, #fb923c, #f97316)',
        'gradient-border': 'linear-gradient(135deg, rgba(251,146,60,0.3), rgba(251,146,60,0.05))',
      },
      fontSize: {
        caption: ['11px', { lineHeight: '16px' }],
        body: ['13px', { lineHeight: '20px' }],
        subhead: ['15px', { lineHeight: '22px' }],
        title: ['22px', { lineHeight: '28px', fontWeight: '700' }],
      },
      keyframes: {
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 20px rgba(251,146,60,0.1)' },
          '50%': { boxShadow: '0 0 30px rgba(251,146,60,0.2)' },
        },
      },
      animation: {
        'glow-pulse': 'glow-pulse 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
```

### F. Component-Level Callouts

**1. Sidebar Navigation Item**
```
Default:  bg-transparent. Icon 18px, #5c5c66 (tertiary), stroke-width 2.
          Label: font-display (Space Grotesk), 13px, text-tertiary
Hover:    bg-elevated (#1e1e24). Icon → text-secondary. 200ms.
Active:   bg-sidebar-active (amber ghost).
          Left edge: 3px rounded bar, gradient amber→orange,
          with subtle glow (box-shadow: -4px 0 12px rgba(251,146,60,0.15))
          Icon → accent (#fb923c). Label → text-primary. font-semibold.
          The glow bar is the signature element of this variant.
```

**2. Data Table Row (Calls View)**
```
Default:  bg-surface (#141418), text-secondary, 1px bottom border-subtle
Hover:    bg-elevated (#1e1e24), text → text-primary
          Left edge animates in: 2px accent border (200ms slide from top)
Missed:   status text #f87171 (error), duration cell shows "—" in text-tertiary
Header:   bg-overlay (#28282f), text uppercase 11px tracking-widest
          font-display (Space Grotesk) for headers — gives table a unique feel
Pagination: amber accent on page numbers, "Prev/Next" buttons with border-accent
```

**3. Backup Selector Card**
```
Default:  bg-surface, 1px border-subtle, rounded-xl
          Device name: font-display 18px text-primary
          Details: body text-secondary
          Size: mono, accent-2 (sky-400) — data stands out
Hover:    Border transitions to gradient (amber→orange at 30% opacity)
          shadow-glow appears. Card lifts translate-y -2px.
          Device name gains text-accent.
          This is the "hero" interaction — first thing users see.
Encrypted:  Pill with amber border + amber text. Subtle glow-pulse animation.
Click:    scale(0.97) 100ms — tactile press.
```

**4. App Logo / Wordmark**
```
"OpenExtract" in Space Grotesk Bold, 18px.
"Open" in text-primary (#eeeef0).
"Extract" in gradient text (amber→orange).
This split treatment makes the name memorable and ties to the accent system.
```

---

## G. Implementation Roadmap (Applies to Any Variant)

Prioritized file changes to implement whichever variant is selected:

### Phase 1 — Foundation (do first)

| Priority | File | Change |
|----------|------|--------|
| 1 | `package.json` | Add dependencies: `lucide-react`, Google Fonts link (Inter, Space Grotesk, JetBrains Mono as needed) |
| 2 | `src/index.css` | Add CSS custom properties (design tokens). Update scrollbar styles. Add font imports. Add dark mode media query (Titanium only). |
| 3 | `tailwind.config.js` | Replace entire `theme.extend` block with chosen variant's config. |
| 4 | `index.html` | Add Google Fonts `<link>` tags in `<head>`. |

### Phase 2 — Shell (header + sidebar)

| Priority | File | Change |
|----------|------|--------|
| 5 | `src/App.tsx` | Redesign header. Replace emoji/text with Lucide icons + refined layout. Update all color classes to use token-based classes. |
| 6 | `src/components/Dashboard.tsx` | Redesign sidebar nav. Replace emoji icons with Lucide components. Implement expanded/collapsed toggle. Apply active state styling. |

### Phase 3 — View-by-View Updates

| Priority | File | Change |
|----------|------|--------|
| 7 | `src/components/BackupSelector.tsx` | Redesign backup cards. Replace emoji (📱). Update button styles. Apply token colors. |
| 8 | `src/components/MessageView.tsx` | Unify to chosen theme. Update conversation list + chat area colors. |
| 9 | `src/components/ChatBubble.tsx` | Update bubble colors to match token system. |
| 10 | `src/components/calls/CallsView.tsx` | Replace hardcoded #hex colors with token classes. Update table styling. |
| 11 | `src/components/contacts/ContactsView.tsx` | Replace hardcoded #hex colors. Update card design. |
| 12 | `src/components/notes/NotesView.tsx` | Apply unified theme. Update typography. |
| 13 | `src/components/voicemail/VoicemailView.tsx` | Apply unified theme. Update expandable list styling. |
| 14 | `src/components/photos/PhotoGallery.tsx` | Update gallery chrome to match theme. |
| 15 | `src/components/photos/PhotoLightbox.tsx` | Update modal overlay + controls. |
| 16 | `src/components/photos/ExportDialog.tsx` | Update dialog styling. |

### Phase 4 — Polish

| Priority | File | Change |
|----------|------|--------|
| 17 | `src/index.css` | Add transition utilities, animation keyframes, focus-visible styles. |
| 18 | All components | Audit for stray hardcoded colors. Ensure AA contrast ratios. |
| 19 | `src/components/Dashboard.tsx` | Add sidebar collapse/expand with localStorage persistence. |
| 20 | All components | Add loading skeleton states (optional but premium feel). |

**Estimated scope:** ~15-20 files, ~800-1200 lines changed depending on variant complexity.
