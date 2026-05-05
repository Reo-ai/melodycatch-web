/**
 * DAW 風ピアノロール表示。
 *
 * - ドラム層 (上部 3 レーン: Hi-Hat / Snare / Kick) +
 *   メロディ層 (オレンジ) と コード層 (インディゴ) を同じタイムライン上に重ねて描画
 * - 横軸: 時間 (秒)、縦軸: ピッチ (MIDI ノート番号) / ドラムは固定 3 レーン
 * - BPM が指定されているときは拍 (beat) と小節 (bar) のグリッドを描画
 * - 録音 / 再生中は赤 or 水色の再生ヘッドが進み、自動スクロールで追尾する
 * - 再生ヘッドは requestAnimationFrame + 直接 DOM 更新で 60fps に近づける
 */

import { useEffect, useMemo, useRef } from "react";
import type { Layer, LayerId } from "../audio/recorder";
import {
  DRUM_HIHAT_MIDI,
  DRUM_KICK_MIDI,
  DRUM_SNARE_MIDI,
  drumKindOf,
  type DrumKind,
} from "../audio/drums";

interface PianoRollProps {
  melody: Layer;
  chord: Layer;
  drum: Layer;
  /** 録音中 or 再生中 */
  isActive: boolean;
  /** 録音中の対象トラック (ハイライト色を変える) */
  recordingLayerId: LayerId | null;
  /** 経過秒を返す。rAF から毎フレーム呼ばれる。 */
  getPlayheadSec: () => number;
  /** BPM (拍グリッドを引くのに使う)。指定なしなら秒グリッド。 */
  bpm?: number;
}

const PX_PER_SEC = 80;
const ROW_HEIGHT = 5;
const PITCH_PAD = 2;
const MIN_PITCH_RANGE = 18;
const MIN_DURATION_SEC = 8;

const DRUM_LANE_HEIGHT = 16;
const DRUM_LANES: { kind: DrumKind; midi: number; label: string; color: string }[] = [
  { kind: "hihat", midi: DRUM_HIHAT_MIDI, label: "HiHat", color: "#facc15" },
  { kind: "snare", midi: DRUM_SNARE_MIDI, label: "Snare", color: "#22c55e" },
  { kind: "kick", midi: DRUM_KICK_MIDI, label: "Kick", color: "#a855f7" },
];
const DRUM_TOTAL_HEIGHT = DRUM_LANES.length * DRUM_LANE_HEIGHT;
const DRUM_PITCH_GAP = 4; // ドラム帯と pitch 帯の境界線のスペース

const COLOR_MELODY = "#f97316"; // orange-500
const COLOR_CHORD = "#6366f1"; // indigo-500
const COLOR_REC = "#ef4444"; // red-500
const COLOR_PLAY = "#0ea5e9"; // sky-500

export default function PianoRoll({
  melody,
  chord,
  drum,
  isActive,
  recordingLayerId,
  getPlayheadSec,
  bpm,
}: PianoRollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<SVGLineElement>(null);

  const { width, pitchHeight, pitchMin, pitchMax, totalSec } = useMemo(() => {
    const all = [...melody.notes, ...chord.notes];
    let pMin = 60;
    let pMax = 72;
    let last = 0;
    if (all.length > 0) {
      pMin = all[0].midi;
      pMax = all[0].midi;
      for (const n of all) {
        if (n.midi < pMin) pMin = n.midi;
        if (n.midi > pMax) pMax = n.midi;
        const e = n.startSec + n.durationSec;
        if (e > last) last = e;
      }
    }
    pMin -= PITCH_PAD;
    pMax += PITCH_PAD;
    while (pMax - pMin < MIN_PITCH_RANGE) {
      pMax++;
      pMin--;
    }
    // ドラムの最後の時間も totalSec に反映
    for (const n of drum.notes) {
      const e = n.startSec + n.durationSec;
      if (e > last) last = e;
    }
    const tot = Math.max(MIN_DURATION_SEC, last + 1.5);
    return {
      width: tot * PX_PER_SEC,
      pitchHeight: (pMax - pMin + 1) * ROW_HEIGHT,
      pitchMin: pMin,
      pitchMax: pMax,
      totalSec: tot,
    };
  }, [melody.notes, chord.notes, drum.notes]);

  const drumTop = 0;
  const pitchTop = DRUM_TOTAL_HEIGHT + DRUM_PITCH_GAP;
  const totalHeight = pitchTop + pitchHeight;

  function noteY(midi: number): number {
    return pitchTop + (pitchMax - midi) * ROW_HEIGHT;
  }

  function drumLaneY(kind: DrumKind): number {
    const idx = DRUM_LANES.findIndex((l) => l.kind === kind);
    return drumTop + idx * DRUM_LANE_HEIGHT;
  }

  // 再生ヘッド rAF ループ
  useEffect(() => {
    if (!isActive) {
      if (playheadRef.current) {
        playheadRef.current.setAttribute("x1", "0");
        playheadRef.current.setAttribute("x2", "0");
      }
      return;
    }
    let raf = 0;
    const loop = () => {
      const sec = getPlayheadSec();
      const x = sec * PX_PER_SEC;
      if (playheadRef.current) {
        playheadRef.current.setAttribute("x1", String(x));
        playheadRef.current.setAttribute("x2", String(x));
      }
      const el = scrollRef.current;
      if (el) {
        const right = el.scrollLeft + el.clientWidth;
        if (x > right - 100) {
          el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
        } else if (x < el.scrollLeft) {
          el.scrollLeft = Math.max(0, x - 40);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isActive, getPlayheadSec]);

  // 拍グリッド (BPM 指定時のみ)
  const beatLines = useMemo(() => {
    if (!bpm) return [] as { sec: number; isBar: boolean }[];
    const beatSec = 60 / bpm;
    const out: { sec: number; isBar: boolean }[] = [];
    for (let b = 0; b * beatSec <= totalSec; b++) {
      out.push({ sec: b * beatSec, isBar: b % 4 === 0 });
    }
    return out;
  }, [bpm, totalSec]);

  const ticks: number[] = [];
  for (let s = 0; s <= Math.ceil(totalSec); s++) ticks.push(s);
  const cLines: number[] = [];
  for (let p = pitchMax; p >= pitchMin; p--) {
    if (p % 12 === 0) cLines.push(p);
  }

  const playheadColor = recordingLayerId ? COLOR_REC : COLOR_PLAY;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-500">
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ backgroundColor: COLOR_MELODY }}
          />
          メロディ ({melody.notes.length})
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ backgroundColor: COLOR_CHORD }}
          />
          コード ({chord.notes.length})
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ backgroundColor: DRUM_LANES[0].color }}
          />
          HiHat
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ backgroundColor: DRUM_LANES[1].color }}
          />
          Snare
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ backgroundColor: DRUM_LANES[2].color }}
          />
          Kick ({drum.notes.length} ヒット)
        </span>
        {bpm && (
          <span className="rounded-full bg-ink-100 px-2 py-0.5 font-mono">
            {bpm} BPM グリッド
          </span>
        )}
        {isActive && (
          <span className="flex items-center gap-1 font-medium">
            <span
              className="inline-block h-3 w-0.5"
              style={{ backgroundColor: playheadColor }}
            />
            {recordingLayerId === "melody"
              ? "🎵 メロディ層を録音中"
              : recordingLayerId === "chord"
                ? "🎼 コード層を録音中"
                : recordingLayerId === "drum"
                  ? "🥁 ドラム層を録音中"
                  : "▶ 再生中"}
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="overflow-x-auto rounded-xl border border-ink-200 bg-ink-50"
        style={{ minHeight: 200 }}
      >
        <svg
          width={width}
          height={totalHeight + 22}
          style={{ display: "block" }}
        >
          {/* ドラムレーン背景 (交互の薄色) */}
          {DRUM_LANES.map((lane, idx) => (
            <g key={`dl${lane.kind}`}>
              <rect
                x={0}
                y={drumLaneY(lane.kind)}
                width={width}
                height={DRUM_LANE_HEIGHT}
                fill={idx % 2 === 0 ? "#f8fafc" : "#eef2f7"}
              />
              <text
                x={4}
                y={drumLaneY(lane.kind) + DRUM_LANE_HEIGHT - 4}
                fontSize="10"
                fill="#475569"
                fontFamily="ui-monospace, monospace"
                fontWeight={600}
              >
                {lane.label}
              </text>
            </g>
          ))}

          {/* ドラム / pitch 境界線 */}
          <line
            x1={0}
            y1={DRUM_TOTAL_HEIGHT + DRUM_PITCH_GAP / 2}
            x2={width}
            y2={DRUM_TOTAL_HEIGHT + DRUM_PITCH_GAP / 2}
            stroke="#94a3b8"
            strokeWidth={1}
          />

          {/* 拍グリッド (BPM 指定時) */}
          {beatLines.map((b, i) => (
            <line
              key={`bb${i}`}
              x1={b.sec * PX_PER_SEC}
              y1={0}
              x2={b.sec * PX_PER_SEC}
              y2={totalHeight}
              stroke={b.isBar ? "#94a3b8" : "#cbd5e1"}
              strokeWidth={b.isBar ? 1 : 0.5}
              strokeDasharray={b.isBar ? undefined : "2 2"}
              opacity={0.7}
            />
          ))}

          {/* time grid (秒) */}
          {ticks.map((s) => (
            <g key={`t${s}`}>
              {!bpm && (
                <line
                  x1={s * PX_PER_SEC}
                  y1={0}
                  x2={s * PX_PER_SEC}
                  y2={totalHeight}
                  stroke={s % 4 === 0 ? "#cbd5e1" : "#e5e7eb"}
                  strokeWidth={1}
                />
              )}
              <text
                x={s * PX_PER_SEC + 3}
                y={totalHeight + 14}
                fontSize="10"
                fill="#94a3b8"
                fontFamily="ui-monospace, monospace"
              >
                {s}s
              </text>
            </g>
          ))}

          {/* C ライン (オクターブ目安) */}
          {cLines.map((p) => (
            <g key={`p${p}`}>
              <line
                x1={0}
                y1={noteY(p)}
                x2={width}
                y2={noteY(p)}
                stroke="#cbd5e1"
                strokeWidth={1}
              />
              <text
                x={4}
                y={noteY(p) - 1}
                fontSize="9"
                fill="#94a3b8"
                fontFamily="ui-monospace, monospace"
              >
                C{Math.floor(p / 12) - 1}
              </text>
            </g>
          ))}

          {/* ドラムノート (上部レーン) */}
          {drum.notes.map((n, i) => {
            const kind = drumKindOf(n.midi);
            if (!kind) return null;
            const lane = DRUM_LANES.find((l) => l.kind === kind);
            if (!lane) return null;
            const w = Math.max(6, n.durationSec * PX_PER_SEC);
            return (
              <rect
                key={`d${i}-${n.midi}-${n.startSec}`}
                x={n.startSec * PX_PER_SEC}
                y={drumLaneY(kind) + 2}
                width={w}
                height={DRUM_LANE_HEIGHT - 4}
                fill={lane.color}
                opacity={0.9}
                rx={2}
              />
            );
          })}

          {/* コードノート (背面) */}
          {chord.notes.map((n, i) => (
            <rect
              key={`c${i}-${n.midi}-${n.startSec}`}
              x={n.startSec * PX_PER_SEC}
              y={noteY(n.midi)}
              width={Math.max(2, n.durationSec * PX_PER_SEC - 1)}
              height={Math.max(2, ROW_HEIGHT - 1)}
              fill={COLOR_CHORD}
              opacity={0.85}
              rx={1}
            />
          ))}

          {/* メロディノート (前面) */}
          {melody.notes.map((n, i) => (
            <rect
              key={`m${i}-${n.midi}-${n.startSec}`}
              x={n.startSec * PX_PER_SEC}
              y={noteY(n.midi)}
              width={Math.max(2, n.durationSec * PX_PER_SEC - 1)}
              height={Math.max(2, ROW_HEIGHT - 1)}
              fill={COLOR_MELODY}
              opacity={0.95}
              rx={1}
            />
          ))}

          {/* 再生ヘッド */}
          <line
            ref={playheadRef}
            x1={0}
            y1={0}
            x2={0}
            y2={totalHeight}
            stroke={playheadColor}
            strokeWidth={2}
            strokeDasharray={recordingLayerId ? "4 2" : undefined}
            style={{ display: isActive ? "block" : "none" }}
          />
        </svg>
      </div>
    </div>
  );
}
