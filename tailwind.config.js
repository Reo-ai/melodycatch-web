/** @type {import('tailwindcss').Config} */

// 色は src/index.css の CSS 変数 (RGB 三つ組) で定義し、ここで参照する。
// ダークテーマ化のため ink は「50 = 最も暗い / 900 = 最も明るい」に反転している。
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const scale = (prefix, steps) =>
  Object.fromEntries(steps.map((s) => [s, v(`${prefix}-${s}`)]));
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "Noto Sans JP",
          "-apple-system",
          "BlinkMacSystemFont",
          "Hiragino Sans",
          "Hiragino Kaku Gothic ProN",
          "Yu Gothic",
          "system-ui",
          "sans-serif",
        ],
        display: ["Space Grotesk", "Inter", "Noto Sans JP", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        ink: scale("ink", STEPS),
        accent: scale("accent", STEPS),
        surface: {
          DEFAULT: v("surface"),
          2: v("surface-2"),
          3: v("surface-3"),
        },
        page: v("page"),
      },
      boxShadow: {
        glow: "0 0 0 1px rgb(var(--accent-400) / 0.35), 0 8px 32px -8px rgb(var(--accent-500) / 0.55)",
        card: "0 1px 0 0 rgb(255 255 255 / 0.04) inset, 0 20px 40px -24px rgb(0 0 0 / 0.8)",
      },
    },
  },
  plugins: [],
}
