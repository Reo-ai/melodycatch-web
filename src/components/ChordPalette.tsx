/**
 * Diatonic chord palette: a row of chord buttons for the active scale.
 *
 * - Each button shows: the chord symbol (e.g. "C", "Am", "B°"),
 *   the Japanese quality label ("メジャー", "マイナー", "ディム(減)") and the
 *   Roman numeral.
 * - Clicking a button plays the chord and lets the parent know which
 *   chord is active so the piano can highlight its constituent notes.
 */

import {
  CHORD_QUALITY_LABEL_JA,
  CHORD_QUALITY_MOOD_JA,
  chordSymbol,
  chordVoicing,
  diatonicTriads,
  type HarmonicChord,
} from "../music/chord";
import type { Scale } from "../music/scale";

interface ChordPaletteProps {
  scale: Scale;
  onPlayChord: (chord: HarmonicChord, midiNotes: number[]) => void;
  /** Index of the chord currently spotlighted (e.g. last played). */
  activeIndex?: number | null;
}

/** Keyboard shortcut hints for diatonic chord palette (Z X C V B N M). */
const KEY_HINTS = ["Z", "X", "C", "V", "B", "N", "M"] as const;

export default function ChordPalette({
  scale,
  onPlayChord,
  activeIndex,
}: ChordPaletteProps) {
  const triads = diatonicTriads(scale);

  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
      {triads.map((chord, i) => {
        const symbol = chordSymbol(chord);
        const labelJa = CHORD_QUALITY_LABEL_JA[chord.quality];
        const mood = CHORD_QUALITY_MOOD_JA[chord.quality];
        const active = activeIndex === i;
        const keyHint = KEY_HINTS[i];
        return (
          <button
            key={`${chord.rootPitchClass}-${chord.quality}-${i}`}
            type="button"
            onClick={() => onPlayChord(chord, chordVoicing(chord, 48))}
            className={[
              "relative flex flex-col items-center justify-center rounded-2xl border px-2 py-3 transition",
              "text-center shadow-sm hover:shadow-md active:scale-95",
              active
                ? "border-accent-500 bg-accent-500 text-white"
                : "border-ink-200 bg-white text-ink-900 hover:border-accent-300",
            ].join(" ")}
          >
            {keyHint && (
              <span
                className={[
                  "absolute right-1.5 top-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded border px-1 text-[9px] font-bold leading-none",
                  active
                    ? "border-white/60 bg-white/20 text-white"
                    : "border-ink-300 bg-ink-50 text-ink-500",
                ].join(" ")}
                aria-hidden="true"
              >
                {keyHint}
              </span>
            )}
            <span className="text-xs font-medium opacity-70">
              {chord.roman ?? ""}
            </span>
            <span className="text-2xl font-bold leading-tight">{symbol}</span>
            <span className="mt-1 text-[11px] leading-tight opacity-80">
              {labelJa}
            </span>
            <span className="mt-0.5 text-[10px] leading-tight opacity-60">
              {mood}
            </span>
          </button>
        );
      })}
    </div>
  );
}
