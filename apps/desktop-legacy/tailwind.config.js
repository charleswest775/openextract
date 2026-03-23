/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
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
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
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
