/**
 * Chord progression preset list.
 *
 * - Each preset is rendered as a card with: Japanese name, mood hint, and
 *   the resolved chord-symbol sequence for the active scale.
 * - Tapping a card plays the progression: the chords are scheduled
 *   sequentially with a gentle gap so the user hears the harmonic motion.
 */

import { useState } from "react";
import { chordSymbol, chordVoicing, type HarmonicChord } from "../music/chord";
import type { Scale } from "../music/scale";
import {
  progressionsFor,
  resolveProgression,
  type ProgressionTemplate,
} from "../music/progressions";

interface ProgressionListProps {
  scale: Scale;
  /**
   * BPM (60-180). 1 コード = 1 小節 (4 拍) として進行を組む。
   * ドラム BPM と一致させると拍が揃う。
   */
  bpm: number;
  /**
   * Schedule a chord to play after `delayMs` and call `onChordChange` so the
   * parent can highlight constituent notes on the piano.
   */
  onPlayChord: (
    chord: HarmonicChord,
    midiNotes: number[],
    delayMs: number,
    durationSec: number,
  ) => void;
  /** Called when the highlight should clear. */
  onProgressionEnd: () => void;
}

export default function ProgressionList({
  scale,
  bpm,
  onPlayChord,
  onProgressionEnd,
}: ProgressionListProps) {
  const templates = progressionsFor(scale);
  const [activeId, setActiveId] = useState<string | null>(null);

  function play(template: ProgressionTemplate) {
    // 1 コード = 1 小節 (4 拍) としてドラム BPM と整合させる
    const safeBpm = Math.max(40, Math.min(220, bpm));
    const msPerBar = (60_000 * 4) / safeBpm;
    const chordGapMs = msPerBar;
    const chordDurSec = (msPerBar * 0.92) / 1000;
    const chords = resolveProgression(scale, template);
    setActiveId(template.id);
    chords.forEach((chord, i) => {
      onPlayChord(
        chord,
        chordVoicing(chord, 48),
        i * chordGapMs,
        chordDurSec,
      );
    });
    const totalMs = chords.length * chordGapMs + 200;
    window.setTimeout(() => {
      setActiveId((cur) => (cur === template.id ? null : cur));
      onProgressionEnd();
    }, totalMs);
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {templates.map((tpl) => {
        const chords = resolveProgression(scale, tpl);
        const symbols = chords.map(chordSymbol).join(" → ");
        const active = activeId === tpl.id;
        return (
          <button
            key={tpl.id}
            type="button"
            onClick={() => play(tpl)}
            className={[
              "flex flex-col items-start gap-1 rounded-2xl border px-4 py-3 text-left transition",
              "shadow-sm hover:shadow-md active:scale-[0.99]",
              active
                ? "border-accent-500 bg-accent-50"
                : "border-ink-200 bg-white hover:border-accent-300",
            ].join(" ")}
          >
            <div className="flex w-full items-baseline justify-between">
              <span className="text-base font-semibold text-ink-900">
                {tpl.name}
              </span>
              <span className="text-[11px] text-ink-500">{tpl.romanLabel}</span>
            </div>
            <span className="text-xs text-ink-500">{tpl.mood}</span>
            <span className="mt-1 text-sm font-medium text-accent-700">
              {symbols}
            </span>
          </button>
        );
      })}
    </div>
  );
}
