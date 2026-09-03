import type { Config } from "tailwindcss"
import animate from "tailwindcss-animate"

/**
 * shadcn/ui CSS-variable theme. Every colour resolves to an `hsl(var(--token))` pair defined
 * in app/globals.css for `:root` (light) and `.dark`, so a theme switch is one class on <html>
 * and never a re-render.
 */
const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./types/**/*.{ts,tsx}"
  ],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: {
        "2xl": "1400px"
      }
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))"
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))"
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))"
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))"
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))"
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))"
        },
        // Named accents, for the places that mean the colour rather than the role:
        // gold on a section number, vermilion on a red card, teal on a live match.
        gold: "hsl(var(--gold))",
        vermilion: "hsl(var(--vermilion))",
        teal: "hsl(var(--teal))",
        azure: "hsl(var(--azure))",
        /**
         * The signed-in person's chosen accent (profiles.accent_color), set as `--accent-user`
         * on the shell by `lib/profile/accent.ts`. Falls back to gold where no profile is loaded.
         */
        user: "hsl(var(--accent-user, var(--gold)))",
        "line-soft": "hsl(var(--line-soft))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))"
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))"
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))"
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))"
        }
      },
      // --radius is 2px. Deriving md/sm by subtraction would land on 0 and -2px, so the
      // scale is flat on purpose: one cut edge everywhere, and pills only where a control
      // is genuinely a chip.
      borderRadius: {
        lg: "var(--radius)",
        md: "var(--radius)",
        sm: "1px"
      },
      fontFamily: {
        // The var() fallback is load-bearing: if --font-sans is ever missing (a page rendered
        // before next/font injects its class, a Storybook-style harness), an unresolved var()
        // makes the WHOLE font-family declaration invalid rather than falling through to the
        // next item in the list. Keeping a fallback inside var() prevents that cliff.
        sans: ["var(--font-sans, ui-sans-serif)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono, ui-monospace)", "SFMono-Regular", "monospace"]
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" }
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" }
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateY(-8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" }
        },
        "toast-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: { opacity: "0", transform: "translateY(-8px) scale(0.98)" }
        }
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "toast-in": "toast-in 0.18s ease-out",
        "toast-out": "toast-out 0.15s ease-in forwards"
      }
    }
  },
  plugins: [animate]
}

export default config
