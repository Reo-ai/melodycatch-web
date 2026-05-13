/**
 * Diatonic chord palette: a row of chord buttons for the active scale.
 *
 * - Each button shows: the chord symbol (e.g. "C", "Am", "B°"),
 *   the Japanese quality label ("メジャー", "マイナー", "ディム(減)") and the
 *   Roman numeral.
 * - Clicking a button plays the chord and lets the parent know which
 *   chord is active so the piano can highlight its constituent notes.
 * - Below each chord button, instrument-specific sub-buttons appear:
 *     - When guitar is armed: one "♪ 8分" button to play an 8-note arpeggio
 *     - When chord (piano) is armed: 5 piano chord pattern buttons (1〜5)
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

/** Pattern identifiers used by sub-buttons. */
export type ChordPatternId =
  | "guitar8th"
  | "piano1"
  | "piano2"
  | "piano3"
  | "piano4"
  | "piano5";

interface ChordPaletteProps {
  scale: Scale;
  onPlayChord: (chord: HarmonicChord, midiNotes: number[]) => void;
  /** Called when an instrument-specific sub-button is pressed. */
  onPlayPattern?: (
    chord: HarmonicChord,
    midiNotes: number[],
    pattern: ChordPatternId,
  ) => void;
  /** Currently armed layer; used to decide which sub-buttons to render. */
  armedLayer?: "melody" | "chord" | "bass" | "synth" | "guitar" | "drum";
  /** Index of the chord currently spotlighted (e.g. last played). */
  activeIndex?: number | null;
}

/** Keyboard shortcut hints for diatonic chord palette (Z X C V B N M). */
const KEY_HINTS = ["Z", "X", "C", "V", "B", "N", "M"] as const;

/** Short Japanese labels for the 5 piano patterns. */
const PIANO_PATTERN_LABELS: Record<
  "piano1" | "piano2" | "piano3" | "piano4" | "piano5",
  { num: string; jp: string }
> = {
  piano1: { num: "1", jp: "ブロック" },
  piano2: { num: "2", jp: "上行アルペジオ" },
  piano3: { num: "3", jp: "下行アルペジオ" },
  piano4: { num: "4", jp: "アルベルティ" },
  piano5: { num: "5", jp: "ベース+和音" },
};

export default function ChordPalette({
  scale,
  onPlayChord,
  onPlayPattern,
  armedLayer,
  activeIndex,
}: ChordPaletteProps) {
  const triads = diatonicTriads(scale);
  const isGuitar = armedLayer === "guitar";
  const isPiano = armedLayer === "chord";

  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
      {triads.map((chord, i) => {
        const symbol = chordSymbol(chord);
        const labelJa = CHORD_QUALITY_LABEL_JA[chord.quality];
        const mood = CHORD_QUALITY_MOOD_JA[chord.quality];
        const active = activeIndex === i;
        const keyHint = KEY_HINTS[i];
        const voicing = chordVoicing(chord, 48);
        return (
          <div
            key={`${chord.rootPitchClass}-${chord.quality}-${i}`}
            className="flex flex-col gap-1"
          >
            <button
              type="button"
              onClick={() => onPlayChord(chord, voicing)}
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

            {/* ギター: 1 個の 8 分音符ストロークボタン */}
            {isGuitar && onPlayPattern && (
              <button
                type="button"
                onClick={() => onPlayPattern(chord, voicing, "guitar8th")}
                title="8 分音符でアルペジオを 1 小節分鳴らす"
                className="rounded-lg border border-amber-400 bg-amber-50 px-1 py-1 text-[10px] font-semibold text-amber-700 shadow-sm hover:bg-amber-100 active:scale-95"
              >
                ♪ 8分
              </button>
            )}

            {/* ピアノ (コード層 armed): 5 個のコードパターンボタン */}
            {isPiano && onPlayPattern && (
              <div className="grid grid-cols-5 gap-0.5">
                {(["piano1", "piano2", "piano3", "piano4", "piano5"] as const).map(
                  (pid) => {
                    const lbl = PIANO_PATTERN_LABELS[pid];
                    return (
                      <button
                        key={pid}
                        type="button"
                        onClick={() => onPlayPattern(chord, voicing, pid)}
                        title={lbl.jp}
                        className="rounded-md border border-indigo-300 bg-indigo-50 px-0.5 py-1 text-[10px] font-bold text-indigo-700 shadow-sm hover:bg-indigo-100 active:scale-95"
                      >
                        {lbl.num}
                      </button>
                    );
                  },
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
