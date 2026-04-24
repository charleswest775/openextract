/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        /* Remap emerald → terracotta (Hearth accent) so all existing
           emerald-* classes pick up the Hearth accent automatically. */
        emerald: {
          50:  '#faeadd',
          100: '#f7e6d8', /* accent-wash */
          200: '#f0c8b0',
          300: '#e8a585',
          400: '#de8c69',
          500: '#d97757', /* accent */
          600: '#c26547',
          700: '#a5532f',
          800: '#843e20',
          900: '#5e2c18',
        },
        /* Remap neutral grays to warm Hearth tones */
        /* teal also maps to terracotta (FirstVisitView uses teal-500/600) */
        teal: {
          50:  '#faeadd',
          100: '#f7e6d8',
          200: '#f0c8b0',
          300: '#e8a585',
          400: '#de8c69',
          500: '#d97757',
          600: '#c26547',
          700: '#a5532f',
          800: '#843e20',
          900: '#5e2c18',
        },
        /* amber → cream (warm yellow). keeps Hearth palette. */
        amber: {
          50:  '#fbf3de',
          100: '#f7e8c2',
          200: '#f0d894',
          300: '#e8c466',
          400: '#d4a245',
          500: '#b8852b',
          600: '#996d1f',
          700: '#785418',
          800: '#564012',
          900: '#35280c',
        },
        gray: {
          50:  '#faf4ec',
          100: '#f2e9dd', /* sand */
          200: '#ece1d1', /* rule */
          300: '#d9c8ad',
          400: '#97897a', /* ink3 */
          500: '#655a4f', /* ink2 */
          600: '#4a4036',
          700: '#332c25',
          800: '#25201b',
          900: '#1e1a16', /* ink */
        },
        base: 'var(--bg-base)',
        surface: 'var(--bg-surface)',
        elevated: 'var(--bg-elevated)',
        sidebar: {
          DEFAULT: 'var(--bg-sidebar)',
          active: 'var(--bg-sidebar-active)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          subtle: 'var(--accent-subtle)',
        },
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-accent': 'var(--text-accent)',
        'border-subtle': 'var(--border-subtle)',
        'border-default': 'var(--border-default)',
        'border-strong': 'var(--border-strong)',
        'apple-success': 'var(--success)',
        'apple-warning': 'var(--warning)',
        'apple-error': 'var(--error)',
        'imessage-blue': '#007AFF',
        'imessage-green': '#34C759',
        'bubble-gray': 'var(--bg-elevated)',
        'bubble-me': 'var(--bubble-me)',
        'bubble-them': 'var(--bubble-them)',
        sand: 'var(--bg-elevated)',
        sage: 'var(--sage)',
        cream: 'var(--cream)',
        ink: 'var(--text-primary)',
        ink2: 'var(--text-secondary)',
        ink3: 'var(--text-tertiary)',
        rule: 'var(--border-default)',
        'accent-wash': 'var(--accent-wash)',
      },
      fontFamily: {
        sans: ['Geist', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['Geist', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
        serif: ['Fraunces', 'Newsreader', 'Georgia', 'serif'],
        mono: ['IBM Plex Mono', 'SF Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        md: '8px',
        lg: '10px',
        xl: '14px',
      },
      boxShadow: {
        'subtle': '0 0.5px 1px rgba(0,0,0,0.1)',
        'card': '0 2px 8px rgba(0,0,0,0.08)',
        'elevated': '0 4px 20px rgba(0,0,0,0.12)',
        'toolbar': '0 0.5px 0 var(--border-default)',
        'focus': '0 0 0 3px var(--accent-subtle)',
      },
      fontSize: {
        'caption': ['11px', { lineHeight: '14px', letterSpacing: '0.01em' }],
        'body': ['13px', { lineHeight: '20px', letterSpacing: '-0.003em' }],
        'subhead': ['15px', { lineHeight: '22px', letterSpacing: '-0.01em' }],
        'title': ['20px', { lineHeight: '24px', letterSpacing: '-0.015em' }],
      },
      backdropBlur: {
        sidebar: '20px',
      },
      borderWidth: {
        'half': '0.5px',
      },
    },
  },
  plugins: [],
};
