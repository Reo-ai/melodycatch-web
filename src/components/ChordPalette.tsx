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
  // ギター系
  | "guitar8th" // 8 分音符アルペジオ (コードトーンを上下行)
  | "guitar8thChord" // 8 分音符長の短いストロークを 1 回
  // アコギ系 (歪みなし、ギターと同じパターン)
  | "acoustic8th" // 8 分音符アルペジオ (アコギ)
  | "acoustic8thChord" // 8 分音符長の短いストロークを 1 回 (アコギ)
  // ピアノ系 — アルペジオ / 分散和音
  | "piano1" // 4 分音符 1 発 (短いブロックコード)
  | "piano2" // 上行アルペジオ
  | "piano3" // 下行アルペジオ
  | "piano4" // アルベルティ
  | "piano5" // ベース+和音
  // ピアノ系 — 全弾きリズムパターン (コードトーンを全部同時に鳴らす)
  | "piano6" // 8 ビート連打 (8 分音符 × 8)
  | "piano7" // 4 ビート連打 (4 分音符 × 4)
  | "piano8" // ハーフ (2 分音符 × 2)
  | "piano9" // シンコペ (1 / &2 / 4)
  | "piano10"; // チャールストン (1 / &2 / 3 / &4)

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
  armedLayer?:
    | "melody"
    | "chord"
    | "bass"
    | "synth"
    | "guitar"
    | "drum"
    | "drumAcoustic"
    | "acoustic"
    | "vocal"
    | "fx";
  /** Index of the chord currently spotlighted (e.g. last played). */
  activeIndex?: number | null;
}

/** Keyboard shortcut hints for diatonic chord palette (Z X C V B N M). */
const KEY_HINTS = ["Z", "X", "C", "V", "B", "N", "M"] as const;

/** Short Japanese labels for piano patterns. 1〜5 = アルペジオ系, 6〜10 = コード全弾きリズム。 */
const PIANO_PATTERN_IDS = [
  "piano1",
  "piano2",
  "piano3",
  "piano4",
  "piano5",
  "piano6",
  "piano7",
  "piano8",
  "piano9",
  "piano10",
] as const;
type PianoPatternId = (typeof PIANO_PATTERN_IDS)[number];
const PIANO_PATTERN_LABELS: Record<PianoPatternId, { num: string; jp: string }> = {
  piano1: { num: "1", jp: "4 分音符 1 発 (短く)" },
  piano2: { num: "2", jp: "上行アルペジオ" },
  piano3: { num: "3", jp: "下行アルペジオ" },
  piano4: { num: "4", jp: "アルベルティ" },
  piano5: { num: "5", jp: "ベース+和音" },
  piano6: { num: "6", jp: "8 ビート連打 (コード全弾き)" },
  piano7: { num: "7", jp: "4 ビート連打 (コード全弾き)" },
  piano8: { num: "8", jp: "ハーフ (2 分音符・コード全弾き)" },
  piano9: { num: "9", jp: "シンコペ (1 / &2 / 4・コード全弾き)" },
  piano10: { num: "10", jp: "チャールストン (1 / &2 / 3 / &4・コード全弾き)" },
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
  const isAcoustic = armedLayer === "acoustic";
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

            {/* ギター: 2 個の 8 分音符ボタン (アルペジオ / 短いコードストローク × 1 回) */}
            {isGuitar && onPlayPattern && (
              <div className="grid grid-cols-2 gap-0.5">
                <button
                  type="button"
                  onClick={() => onPlayPattern(chord, voicing, "guitar8th")}
                  title="8 分音符でアルペジオを 1 小節分鳴らす"
                  className="rounded-md border border-amber-400 bg-amber-50 px-0.5 py-1 text-[10px] font-semibold text-amber-700 shadow-sm hover:bg-amber-100 active:scale-95"
                >
                  ♪ アルペ
                </button>
                <button
                  type="button"
                  onClick={() => onPlayPattern(chord, voicing, "guitar8thChord")}
                  title="8 分音符長の短いコードストロークを 1 回鳴らす"
                  className="rounded-md border border-amber-500 bg-amber-100 px-0.5 py-1 text-[10px] font-semibold text-amber-800 shadow-sm hover:bg-amber-200 active:scale-95"
                >
                  ♫ 8 分
                </button>
              </div>
            )}

            {/* アコギ: ギターと同じ 2 個のボタン (歪みなしクリーン版) */}
            {isAcoustic && onPlayPattern && (
              <div className="grid grid-cols-2 gap-0.5">
                <button
                  type="button"
                  onClick={() => onPlayPattern(chord, voicing, "acoustic8th")}
                  title="アコギ: 8 分音符でアルペジオを 1 小節分鳴らす"
                  className="rounded-md border border-orange-400 bg-orange-50 px-0.5 py-1 text-[10px] font-semibold text-orange-700 shadow-sm hover:bg-orange-100 active:scale-95"
                >
                  ♪ アルペ
                </button>
                <button
                  type="button"
                  onClick={() => onPlayPattern(chord, voicing, "acoustic8thChord")}
                  title="アコギ: 8 分音符長の短いコードストロークを 1 回鳴らす"
                  className="rounded-md border border-orange-500 bg-orange-100 px-0.5 py-1 text-[10px] font-semibold text-orange-800 shadow-sm hover:bg-orange-200 active:scale-95"
                >
                  ♫ 8 分
                </button>
              </div>
            )}

            {/* ピアノ (コード層 armed): 10 個のコードパターンボタン (5 × 2 行) */}
            {/* 1〜5 = アルペジオ系, 6〜10 = コード全弾きリズム */}
            {isPiano && onPlayPattern && (
              <div className="grid grid-cols-5 gap-0.5">
                {PIANO_PATTERN_IDS.map((pid) => {
                  const lbl = PIANO_PATTERN_LABELS[pid];
                  // 6〜10 はコード全弾き系なのでアクセントカラーで区別。
                  const isBlock = pid === "piano1"
                    || pid === "piano6"
                    || pid === "piano7"
                    || pid === "piano8"
                    || pid === "piano9"
                    || pid === "piano10";
                  const cls = isBlock && pid !== "piano1"
                    ? "rounded-md border border-emerald-400 bg-emerald-50 px-0.5 py-1 text-[10px] font-bold text-emerald-700 shadow-sm hover:bg-emerald-100 active:scale-95"
                    : "rounded-md border border-indigo-300 bg-indigo-50 px-0.5 py-1 text-[10px] font-bold text-indigo-700 shadow-sm hover:bg-indigo-100 active:scale-95";
                  return (
                    <button
                      key={pid}
                      type="button"
                      onClick={() => onPlayPattern(chord, voicing, pid)}
                      title={lbl.jp}
                      className={cls}
                    >
                      {lbl.num}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
