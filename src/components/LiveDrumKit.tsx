/**
 * ライブドラムキット (フルキット)。
 *
 * - 11 種類のドラムピース (Kick / Snare / Hi-hat 閉 / Hi-hat 開 / Ride / Crash /
 *   Tom Hi / Tom Mid / Tom Lo / Clap / Rim) を 2 段配置で表示する
 * - タップ / マウス / マルチタッチで叩いてリアルタイム発音
 * - PC キーボードショートカット:
 *     A=Kick  S=Snare  D=Hat閉  F=Hat開  G=Ride
 *     Q=Crash W=TomHi  E=TomMid R=TomLo  T=Clap  Y=Rim
 * - 各パッド: pad 上半分 = 強打 (vel 1.0)、下半分 = 弱打 (vel 0.65) 風に
 *   タップ Y 位置でベロシティを変化させ「叩き分け」が出来る
 * - `onHit(midi, velocity)` を発火して親 (Studio) の録音システムと連動
 */

import { useCallback, useEffect, useRef } from "react";
import {
  DRUM_CLAP_MIDI,
  DRUM_CRASH_MIDI,
  DRUM_HIHAT_MIDI,
  DRUM_HIHAT_OPEN_MIDI,
  DRUM_KICK_MIDI,
  DRUM_RIDE_MIDI,
  DRUM_RIM_MIDI,
  DRUM_SNARE_MIDI,
  DRUM_TOM_HI_MIDI,
  DRUM_TOM_LO_MIDI,
  DRUM_TOM_MID_MIDI,
  triggerDrumHit,
} from "../audio/drums";
import { ensureAudio } from "../audio/pianoEngine";

interface PadDef {
  midi: number;
  label: string;
  sub: string;
  key: string; // PC キー (小文字)
  /** 配色クラス (Tailwind) */
  toneTop: string;
  toneBottom: string;
  textOn: string;
}

const KIT_TOP: PadDef[] = [
  {
    midi: DRUM_CRASH_MIDI,
    label: "Crash",
    sub: "C#3",
    key: "q",
    toneTop: "from-amber-300 to-amber-500",
    toneBottom: "from-amber-200 to-amber-400",
    textOn: "text-amber-900",
  },
  {
    midi: DRUM_TOM_HI_MIDI,
    label: "Tom Hi",
    sub: "D3",
    key: "w",
    toneTop: "from-orange-300 to-orange-500",
    toneBottom: "from-orange-200 to-orange-400",
    textOn: "text-orange-900",
  },
  {
    midi: DRUM_TOM_MID_MIDI,
    label: "Tom Mid",
    sub: "B2",
    key: "e",
    toneTop: "from-amber-400 to-amber-600",
    toneBottom: "from-amber-300 to-amber-500",
    textOn: "text-amber-50",
  },
  {
    midi: DRUM_TOM_LO_MIDI,
    label: "Tom Lo",
    sub: "A2",
    key: "r",
    toneTop: "from-orange-400 to-orange-600",
    toneBottom: "from-orange-300 to-orange-500",
    textOn: "text-orange-50",
  },
  {
    midi: DRUM_CLAP_MIDI,
    label: "Clap",
    sub: "D#2",
    key: "t",
    toneTop: "from-pink-300 to-pink-500",
    toneBottom: "from-pink-200 to-pink-400",
    textOn: "text-pink-900",
  },
  {
    midi: DRUM_RIM_MIDI,
    label: "Rim",
    sub: "C#2",
    key: "y",
    toneTop: "from-fuchsia-300 to-fuchsia-500",
    toneBottom: "from-fuchsia-200 to-fuchsia-400",
    textOn: "text-fuchsia-900",
  },
];

const KIT_BOTTOM: PadDef[] = [
  {
    midi: DRUM_KICK_MIDI,
    label: "Kick",
    sub: "C2 / A",
    key: "a",
    toneTop: "from-rose-400 to-rose-600",
    toneBottom: "from-rose-300 to-rose-500",
    textOn: "text-rose-50",
  },
  {
    midi: DRUM_SNARE_MIDI,
    label: "Snare",
    sub: "D2 / S",
    key: "s",
    toneTop: "from-red-400 to-red-600",
    toneBottom: "from-red-300 to-red-500",
    textOn: "text-red-50",
  },
  {
    midi: DRUM_HIHAT_MIDI,
    label: "Hat 閉",
    sub: "F#2 / D",
    key: "d",
    toneTop: "from-sky-400 to-sky-600",
    toneBottom: "from-sky-300 to-sky-500",
    textOn: "text-sky-50",
  },
  {
    midi: DRUM_HIHAT_OPEN_MIDI,
    label: "Hat 開",
    sub: "A#2 / F",
    key: "f",
    toneTop: "from-cyan-300 to-cyan-500",
    toneBottom: "from-cyan-200 to-cyan-400",
    textOn: "text-cyan-900",
  },
  {
    midi: DRUM_RIDE_MIDI,
    label: "Ride",
    sub: "D#3 / G",
    key: "g",
    toneTop: "from-yellow-300 to-yellow-500",
    toneBottom: "from-yellow-200 to-yellow-400",
    textOn: "text-yellow-900",
  },
];

const ALL_PADS = [...KIT_TOP, ...KIT_BOTTOM];

interface LiveDrumKitProps {
  /** 録音と連動させたいときに使う発火コールバック。 */
  onHit?: (midi: number, velocity: number) => void;
  /** armed === "drum" などのときに視覚的に強調する。 */
  armed?: boolean;
}

export default function LiveDrumKit({ onHit, armed = false }: LiveDrumKitProps) {
  const flashRef = useRef<Map<number, number>>(new Map());
  const onHitRef = useRef<typeof onHit>(undefined);

  // 最新の onHit を ref に保持 (effect 内 listener の stale 対策)
  useEffect(() => {
    onHitRef.current = onHit;
  }, [onHit]);

  /** 1 ヒット: 音 + 視覚フラッシュ + onHit 通知 */
  const fire = useCallback((midi: number, velocity: number) => {
    void ensureAudio().then(() => {
      triggerDrumHit(midi, undefined, velocity);
    });
    onHitRef.current?.(midi, velocity);
    // フラッシュ
    const el = document.getElementById(`live-drum-pad-${midi}`);
    if (el) {
      el.classList.add("ring-4", "ring-white", "scale-95");
      const prev = flashRef.current.get(midi);
      if (prev !== undefined) window.clearTimeout(prev);
      const t = window.setTimeout(() => {
        el.classList.remove("ring-4", "ring-white", "scale-95");
        flashRef.current.delete(midi);
      }, 120);
      flashRef.current.set(midi, t);
    }
  }, []);

  /** タップ位置で強弱を変える: 上=強(1.0), 下=弱(0.65) */
  const handlePointer = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, midi: number) => {
      e.preventDefault();
      // 自前で pointerup を待つ必要はないので、押下時に 1 ヒット
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const yRel = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const velocity = 1.0 - yRel * 0.45; // 1.0 → 0.55
      fire(midi, velocity);
    },
    [fire],
  );

  // PC キーボード対応 (グローバル listener。input にフォーカス中は無視)
  useEffect(() => {
    const keyToMidi: Record<string, number> = {};
    for (const p of ALL_PADS) keyToMidi[p.key] = p.midi;
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // テキスト入力中は無視
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      const k = e.key.toLowerCase();
      const midi = keyToMidi[k];
      if (midi === undefined) return;
      e.preventDefault();
      fire(midi, 0.95);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fire]);

  return (
    <div
      className={[
        "rounded-2xl p-2 transition",
        armed
          ? "bg-rose-50 ring-2 ring-rose-300"
          : "bg-ink-50 ring-1 ring-ink-200",
      ].join(" ")}
    >
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold text-ink-600">
          🥁 ライブドラム (フルキット)
        </span>
        <span className="text-[10px] text-ink-500">
          パッドをタップ / PC: A〜G・Q〜Y
        </span>
      </div>

      {/* 上段: シンバル + タム + 装飾 */}
      <div className="grid grid-cols-6 gap-1.5">
        {KIT_TOP.map((p) => (
          <DrumButton key={p.midi} pad={p} onPointerDown={(e) => handlePointer(e, p.midi)} />
        ))}
      </div>

      {/* 下段: メインキット (キック/スネア/ハット/ライド) */}
      <div className="mt-1.5 grid grid-cols-5 gap-1.5">
        {KIT_BOTTOM.map((p) => (
          <DrumButton key={p.midi} pad={p} onPointerDown={(e) => handlePointer(e, p.midi)} big />
        ))}
      </div>

      <p className="mt-2 px-1 text-[10px] text-ink-500">
        パッド上=強打 / 下=弱打 でベロシティが変わります。armed が「ドラム」なら録音にも入ります。
      </p>
    </div>
  );
}

function DrumButton({
  pad,
  onPointerDown,
  big = false,
}: {
  pad: PadDef;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  big?: boolean;
}) {
  return (
    <button
      id={`live-drum-pad-${pad.midi}`}
      type="button"
      onPointerDown={onPointerDown}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={`${pad.label} (MIDI ${pad.midi})`}
      className={[
        "relative select-none touch-none rounded-xl border border-ink-300/60 shadow-sm transition-transform active:scale-95",
        big ? "h-20 sm:h-24" : "h-14 sm:h-16",
        // グラデーション (上段=ライト, 下段=ダーク 系)
        "bg-gradient-to-b",
        pad.toneTop,
      ].join(" ")}
      style={{ WebkitTapHighlightColor: "transparent" }}
    >
      <span
        className={[
          "absolute inset-0 flex flex-col items-center justify-center gap-0.5 font-semibold drop-shadow-sm",
          pad.textOn,
          big ? "text-sm" : "text-xs",
        ].join(" ")}
      >
        <span>{pad.label}</span>
        <span className="text-[10px] font-medium opacity-75">{pad.sub}</span>
      </span>
    </button>
  );
}
