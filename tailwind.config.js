/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        droid: {
          bg: 'var(--droid-bg)',
          surface: 'var(--droid-surface)',
          elevated: 'var(--droid-elevated)',
          border: 'var(--droid-border)',
          'border-hover': 'var(--droid-border-hover)',
          text: 'var(--droid-text)',
          'text-secondary': 'var(--droid-text-secondary)',
          'text-muted': 'var(--droid-text-muted)',
          accent: 'var(--droid-accent)',
          green: 'var(--droid-green)',
          orange: 'var(--droid-orange)',
        }
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
      }
    },
  },
  plugins: [],
}
