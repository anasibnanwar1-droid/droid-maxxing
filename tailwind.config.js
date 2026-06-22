/** @type {import('tailwindcss').Config} */
// Wrap each themed CSS variable so Tailwind's `/opacity` modifiers resolve to a
// valid color. Without this, `border-droid-border/40` emits an invalid value and
// border-color falls back to currentColor (producing bright/white borders).
const v = (name) => `color-mix(in srgb, var(${name}) calc(<alpha-value> * 100%), transparent)`;

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        droid: {
          bg: v('--droid-bg'),
          surface: v('--droid-surface'),
          elevated: v('--droid-elevated'),
          border: v('--droid-border'),
          'border-hover': v('--droid-border-hover'),
          text: v('--droid-text'),
          'text-secondary': v('--droid-text-secondary'),
          'text-muted': v('--droid-text-muted'),
          accent: v('--droid-accent'),
          green: v('--droid-green'),
          orange: v('--droid-orange'),
          red: v('--droid-red'),
        },
      },
      fontFamily: {
        sans: ['"SF Pro Display"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(232, 168, 56, 0.3)' },
          '50%': { boxShadow: '0 0 0 4px rgba(232, 168, 56, 0)' },
        },
      },
    },
  },
  plugins: [],
};
