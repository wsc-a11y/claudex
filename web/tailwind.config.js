/** @type {import('tailwindcss').Config} */

// Helper — reference a CSS custom property (RGB triplet) with opacity support.
const rgb = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: rgb("canvas"),
        paper: rgb("paper"),
        ink: {
          DEFAULT: rgb("ink"),
          soft: rgb("ink-soft"),
          muted: rgb("ink-muted"),
          faint: rgb("ink-faint"),
        },
        line: {
          DEFAULT: rgb("line"),
          strong: rgb("line-strong"),
        },
        klein: {
          DEFAULT: rgb("klein"),
          soft: rgb("klein-soft"),
          ink: rgb("klein-ink"),
          wash: rgb("klein-wash"),
        },
        success: { DEFAULT: rgb("success"), wash: rgb("success-wash"), ink: rgb("success-ink") },
        warn: { DEFAULT: rgb("warn"), wash: rgb("warn-wash"), ink: rgb("warn-ink") },
        danger: { DEFAULT: rgb("danger"), wash: rgb("danger-wash"), ink: rgb("danger-ink") },
        indigo: { DEFAULT: rgb("indigo"), wash: rgb("indigo-wash"), ink: rgb("indigo-ink") },
        purple: { DEFAULT: rgb("purple"), wash: rgb("purple-wash") },

        // Semantic surface aliases (usable as bg-surface-base etc.)
        surface: {
          base: rgb("canvas"),
          raised: rgb("paper"),
          overlay: "rgb(var(--surface-overlay) / <alpha-value>)",
        },
      },
      fontFamily: {
        serif: ['"Fraunces"', "Georgia", "ui-serif", "serif"],
        sans: ['"Geist"', '"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      fontSize: {
        ui: "var(--fs-base)",
        "ui-sm": "var(--fs-meta)",
        "ui-lg": "var(--fs-body)",
        "ui-heading": "var(--fs-heading)",
        "ui-subhead": "var(--fs-subhead)",
        "ui-title": "var(--fs-title)",
        "ui-title-lg": "var(--fs-title-lg)",
        "ui-display": "var(--fs-display)",
        "ui-display-lg": "var(--fs-display-lg)",
        "ui-display-xl": "var(--fs-display-xl)",
      },
      borderRadius: {
        xs: "var(--r-xs)",
        sm: "var(--r-sm)",
        DEFAULT: "var(--r-md)",
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
        "2xl": "var(--r-2xl)",
      },
      boxShadow: {
        card: "var(--shadow-1)",
        raised: "var(--shadow-2)",
        lift: "var(--shadow-3)",
        overlay: "var(--shadow-3)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
        slow: "var(--duration-slow)",
      },
      transitionTimingFunction: {
        "out-expo": "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
      },
      zIndex: {
        base: "var(--z-base)",
        raised: "var(--z-raised)",
        sticky: "var(--z-sticky)",
        overlay: "var(--z-overlay)",
        modal: "var(--z-modal)",
        toast: "var(--z-toast)",
      },
    },
  },
  plugins: [],
};
