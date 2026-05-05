/**
 * メロディ用のスケール構成音ピアノ。
 *
 * - スケール内の音だけを並べた、必ずキーから外れないミニピアノ。
 *   → 押した音はコード進行に対して不協和音にならない (= 必ず曲に馴染む)。
 * - コードが選択されている場合は、その構成音 (コードトーン) を強調表示し、
 *   "最も安全な着地音" を可視化する。
 *   - スケール内・コードトーン: 濃いアクセント色 (★)
 *   - スケール内・非コードトーン: 薄いアクセント色 (経過音 / テンション)
 *   - スケールルート: ROOT ラベル
 * - 複数オクターブにまたがって並ぶので、メロディの上下動も表現できる。
 * - グリッサンド (ポインタを滑らせて連続発音) にも対応。
 *
 * Props:
 *   scale: スケール (必須)
 *   chord: コード (任意; 指定するとコードトーンを強調)
 *   bassMidi: 一番低いスケール構成音の最低 MIDI ノート (既定: 48 = C3)
 *   octaveSpan: 何オクターブ並べるか (既定: 2)
 *   activeNotes: 現在押下中の MIDI ノート集合 (見た目反映)
 *   onNoteOn / onNoteOff: 既存の handleNoteOn/Off と互換のシグネチャ
 */

import { useMemo, useRef } from "react";
import {
  CHORD_INTERVALS,
  chordSymbol,
  type HarmonicChord,
} from "../music/chord";
import { SHARP_NAMES, pitchClass } from "../music/pitch";
import {
  SCALE_INTERVALS,
  nearestRootAtOrAbove,
  scaleDisplayName,
  type Scale,
} from "../music/scale";

interface ChordTonePianoProps {
  scale: Scale;
  chord?: HarmonicChord | null;
  bassMidi?: number;
  octaveSpan?: number;
  activeNotes?: Set<number>;
  onNoteOn: (midi: number) => void;
  onNoteOff: (midi: number) => void;
}

const DEFAULT_BASS_MIDI = 48; // C3
const DEFAULT_OCTAVE_SPAN = 2;

export default function ChordTonePiano({
  scale,
  chord,
  bassMidi = DEFAULT_BASS_MIDI,
  octaveSpan = DEFAULT_OCTAVE_SPAN,
  activeNotes,
  onNoteOn,
  onNoteOff,
}: ChordTonePianoProps) {
  const pressed = useRef<Set<number>>(new Set());

  // スケール構成音を octaveSpan オクターブ分並べる
  const tones: number[] = useMemo(() => {
    const ivs = SCALE_INTERVALS[scale.kind];
    const root = nearestRootAtOrAbove(scale, bassMidi);
    const list: number[] = [];
    for (let oct = 0; oct < octaveSpan; oct++) {
      for (const iv of ivs) {
        const m = root + oct * 12 + iv;
        if (m >= 0 && m <= 127) list.push(m);
      }
    }
    return list;
  }, [scale, bassMidi, octaveSpan]);

  // コードトーンの pitchClass セット
  const chordPitchClasses = useMemo(() => {
    if (!chord) return null;
    const set = new Set<number>();
    for (const iv of CHORD_INTERVALS[chord.quality]) {
      set.add((chord.rootPitchClass + iv) % 12);
    }
    return set;
  }, [chord]);

  function press(midi: number) {
    if (pressed.current.has(midi)) return;
    pressed.current.add(midi);
    onNoteOn(midi);
  }

  function release(midi: number) {
    if (!pressed.current.has(midi)) return;
    pressed.current.delete(midi);
    onNoteOff(midi);
  }

  function midiFromPointerEvent(
    e: React.PointerEvent | PointerEvent,
  ): number | null {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target) return null;
    const attr = (target as HTMLElement).dataset?.midi;
    return attr ? Number(attr) : null;
  }

  function handlePointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const m = midiFromPointerEvent(e);
    if (m != null) press(m);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (e.buttons === 0 && e.pointerType === "mouse") return;
    const m = midiFromPointerEvent(e);
    pressed.current.forEach((p) => {
      if (p !== m) release(p);
    });
    if (m != null) press(m);
  }

  function handlePointerUp(e: React.PointerEvent) {
    const m = midiFromPointerEvent(e);
    if (m != null) release(m);
    pressed.current.forEach((p) => release(p));
  }

  function handlePointerCancel() {
    pressed.current.forEach((p) => release(p));
  }

  function noteLabel(m: number): string {
    return `${SHARP_NAMES[pitchClass(m)]}${Math.floor(m / 12) - 1}`;
  }

  return (
    <div
      className="select-none touch-pan-x"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerCancel}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-1">
        <span className="text-xs text-ink-500">
          🎹 <b>{scaleDisplayName(scale)}</b> スケールの構成音だけ
          {chord && (
            <>
              {" / "}
              <span className="text-accent-700">
                <b>{chordSymbol(chord)}</b> のコードトーンは★強調
              </span>
            </>
          )}
        </span>
        <span className="text-[11px] text-ink-400">
          {tones.length} 音 / {octaveSpan} オクターブ
        </span>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-ink-50 p-2">
        <div
          className="flex gap-1.5"
          style={{ minWidth: tones.length * 56 }}
        >
          {tones.map((m) => {
            const pc = pitchClass(m);
            const isRoot = pc === scale.rootPitchClass;
            const isChordTone = chordPitchClasses?.has(pc) ?? false;
            const active = activeNotes?.has(m) ?? false;
            return (
              <button
                key={m}
                type="button"
                data-midi={m}
                aria-label={noteLabel(m)}
                className={[
                  "flex h-24 w-14 shrink-0 flex-col items-center justify-end rounded-xl border pb-2 transition",
                  "shadow-sm active:scale-[0.97]",
                  active
                    ? "border-accent-600 bg-accent-500 text-white"
                    : isChordTone
                      ? "border-accent-500 bg-accent-200 text-accent-900 hover:bg-accent-300"
                      : "border-ink-200 bg-white text-ink-700 hover:border-accent-300",
                  isRoot && !active ? "ring-2 ring-accent-400 ring-inset" : "",
                ].join(" ")}
                style={{ touchAction: "none" }}
              >
                <span className="text-[10px] uppercase tracking-wide opacity-70">
                  {isRoot ? "ROOT" : isChordTone ? "★" : ""}
                </span>
                <span className="text-base font-bold">{noteLabel(m)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
