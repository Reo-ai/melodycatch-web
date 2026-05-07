/**
 * DAW 風ピアノロール表示。
 *
 * - ドラム層 (上部 3 レーン: Hi-Hat / Snare / Kick) +
 *   メロディ / コード / ベース / シンセ / ギター を同じタイムライン上に重ねて描画
 * - 横軸: 時間 (秒)、縦軸: ピッチ (MIDI ノート番号) / ドラムは固定 3 レーン
 * - BPM が指定されているときは拍 (beat) と小節 (bar) のグリッドを描画
 * - 録音 / 再生中は赤 or 水色の再生ヘッドが進み、自動スクロールで追尾する
 *
 * 編集モード操作 (editMode = true のとき):
 *   - 空エリアをクリック     → armedLayer に新規ノート追加
 *   - 空エリアをドラッグ     → 矩形範囲選択 (中に入った全ノートを選択)
 *   - ノート本体をドラッグ   → そのノートを (時間 + ピッチ) ともに自由移動
 *                              選択中なら選択中の全ノートを一緒に移動
 *   - ノート右端ドラッグ     → 終端を伸縮 (右側 RESIZE)
 *   - ノート左端ドラッグ     → 始端を伸縮 (左側 RESIZE — 終端固定)
 *   - Shift+クリック         → 選択へ追加 / 解除
 *   - Delete / Backspace     → 選択中のノートを一括削除
 *   - Esc                    → 選択クリア
 *   - Alt キー押しながら     → BPM グリッドへのスナップを一時無効化
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
  bass: Layer;
  synth: Layer;
  guitar: Layer;
  /** 録音中 or 再生中 */
  isActive: boolean;
  /** 録音中の対象トラック (ハイライト色を変える) */
  recordingLayerId: LayerId | null;
  /** 経過秒を返す。rAF から毎フレーム呼ばれる。 */
  getPlayheadSec: () => number;
  /** BPM (拍グリッドを引くのに使う)。指定なしなら秒グリッド。 */
  bpm?: number;
  /** 編集モード: クリックでノート追加/削除 */
  editMode?: boolean;
  /** 編集モード時の追加対象レイヤ */
  armedLayer?: LayerId;
  /** 空白クリック → ノート追加 */
  onAddNote?: (layerId: LayerId, midi: number, startSec: number) => void;
  /** ノートクリック → 削除 (単発削除 / 互換) */
  onDeleteNote?: (layerId: LayerId, index: number) => void;
  /** ノート端ドラッグ → 長さ変更。side="left" のときは始端、"right" のときは終端を動かす。 */
  onResizeNote?: (
    layerId: LayerId,
    index: number,
    durationSec: number,
    side?: "right" | "left",
  ) => void;
  /** 範囲選択 → 一括削除 */
  onDeleteNotes?: (selections: { layerId: LayerId; index: number }[]) => void;
  /** ノート/範囲移動 → (deltaSec, deltaMidi) でずらす */
  onMoveNotes?: (
    selections: { layerId: LayerId; index: number }[],
    deltaSec: number,
    deltaMidi: number,
  ) => void;
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
const DRUM_PITCH_GAP = 4;

const COLOR_MELODY = "#f97316";
const COLOR_CHORD = "#6366f1";
const COLOR_BASS = "#0d9488";
const COLOR_SYNTH = "#ec4899";
const COLOR_GUITAR = "#b45309";
const COLOR_REC = "#ef4444";
const COLOR_PLAY = "#0ea5e9";
/** 端を掴むためのつまみ幅 (px)。短いノートでは自動的に半分以下に縮める。 */
const RESIZE_HANDLE_WIDTH = 6;
/** 移動と単発クリック (削除) を区別する閾値 (px)。これ未満で離せばクリック扱い。 */
const CLICK_THRESHOLD_PX = 4;
/** 選択中のノートを示すアウトライン色 */
const SELECTION_OUTLINE = "#0ea5e9";

type SelKey = string; // `${layerId}:${index}`
function selKey(layerId: LayerId, index: number): SelKey {
  return `${layerId}:${index}`;
}
function parseSel(key: SelKey): { layerId: LayerId; index: number } {
  const [l, i] = key.split(":");
  return { layerId: l as LayerId, index: Number(i) };
}

interface MoveDrag {
  kind: "move";
  startX: number;
  startY: number;
  selections: { layerId: LayerId; index: number }[];
  /** ドラッグ開始時にすでに選択されていなかった場合 (= 単発ノートをドラッグ)、
   *  クリック扱いになったときに削除すべきか判定するためのターゲット */
  clickTarget?: { layerId: LayerId; index: number };
  moved: boolean;
}

interface ResizeDrag {
  kind: "resize";
  side: "left" | "right";
  layerId: LayerId;
  index: number;
  startX: number;
  origStartSec: number;
  origDurationSec: number;
}

interface MarqueeDrag {
  kind: "marquee";
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  /** Shift で押下開始したか。true なら既存選択を残して追加選択。 */
  additive: boolean;
  /** Shift 開始時のスナップショット (削除/追加判定の起点) */
  origSelection: Set<SelKey>;
}

type Drag = MoveDrag | ResizeDrag | MarqueeDrag;

export default function PianoRoll({
  melody,
  chord,
  drum,
  bass,
  synth,
  guitar,
  isActive,
  recordingLayerId,
  getPlayheadSec,
  bpm,
  editMode = false,
  armedLayer,
  onAddNote,
  onDeleteNote,
  onResizeNote,
  onDeleteNotes,
  onMoveNotes,
}: PianoRollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<SVGLineElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [selection, setSelection] = useState<Set<SelKey>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);

  // 編集モードを抜けたら選択クリア
  useEffect(() => {
    if (!editMode) {
      setSelection(new Set());
      setDrag(null);
    }
  }, [editMode]);

  const { width, pitchHeight, pitchMin, pitchMax, totalSec } = useMemo(() => {
    const all = [
      ...melody.notes,
      ...chord.notes,
      ...bass.notes,
      ...synth.notes,
      ...guitar.notes,
    ];
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
  }, [melody.notes, chord.notes, drum.notes, bass.notes, synth.notes, guitar.notes]);

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

  /** ピクセル座標 → 秒。snapEnabled なら BPM グリッドにスナップ (1/16 が基本)。 */
  function snapSec(sec: number, snapEnabled: boolean): number {
    if (!snapEnabled || !bpm) return sec;
    const beatSec = 60 / Math.max(1, bpm);
    const grid = beatSec / 4; // 1/16
    return Math.round(sec / grid) * grid;
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

  // ---- レイヤごとのノート取得ヘルパ -----------------------------------------
  const layers: { id: LayerId; layer: Layer; color: string; opacity: number }[] = [
    { id: "bass", layer: bass, color: COLOR_BASS, opacity: 0.85 },
    { id: "chord", layer: chord, color: COLOR_CHORD, opacity: 0.85 },
    { id: "synth", layer: synth, color: COLOR_SYNTH, opacity: 0.9 },
    { id: "guitar", layer: guitar, color: COLOR_GUITAR, opacity: 0.9 },
    { id: "melody", layer: melody, color: COLOR_MELODY, opacity: 0.95 },
  ];
  // ---- SVG 座標変換 ---------------------------------------------------------
  function svgPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // ---- 編集モード: 空エリア pointer down ------------------------------------
  function handleSvgPointerDown(e: ReactPointerEvent) {
    if (!editMode) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if ((e.target as Element).closest("[data-note]")) return; // ノート押下は別ハンドラ
    if ((e.target as Element).closest("[data-resize]")) return;

    // 通常クリック (マウスを動かさず離した場合) でノート追加するため、
    // 直ちには追加せず marquee として開始。pointerup 時に「動かなかった」なら追加扱い。
    const pt = svgPoint(e.clientX, e.clientY);
    if (!pt) return;

    (e.target as Element).setPointerCapture?.(e.pointerId);

    setDrag({
      kind: "marquee",
      startX: pt.x,
      startY: pt.y,
      curX: pt.x,
      curY: pt.y,
      additive: e.shiftKey,
      origSelection: new Set(selection),
    });
    if (!e.shiftKey) {
      setSelection(new Set());
    }
  }

  // ---- ノート本体 pointer down → 移動開始 -----------------------------------
  function handleNotePointerDown(
    e: ReactPointerEvent,
    layerId: LayerId,
    index: number,
  ) {
    if (!editMode) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();

    const key = selKey(layerId, index);

    let activeSelection: Set<SelKey>;
    if (e.shiftKey) {
      // Shift 押下: トグル
      activeSelection = new Set(selection);
      if (activeSelection.has(key)) activeSelection.delete(key);
      else activeSelection.add(key);
    } else if (selection.has(key)) {
      // すでに選択中: 既存選択を維持して全部一緒にドラッグ
      activeSelection = new Set(selection);
    } else {
      // 単発: そのノートだけ選択
      activeSelection = new Set([key]);
    }
    setSelection(activeSelection);

    (e.target as Element).setPointerCapture?.(e.pointerId);

    setDrag({
      kind: "move",
      startX: e.clientX,
      startY: e.clientY,
      selections: [...activeSelection].map(parseSel),
      clickTarget: !selection.has(key) && !e.shiftKey
        ? { layerId, index }
        : undefined,
      moved: false,
    });
  }

  // ---- ノート端 pointer down → リサイズ開始 ---------------------------------
  function handleResizePointerDown(
    e: ReactPointerEvent,
    layerId: LayerId,
    index: number,
    side: "left" | "right",
    origStartSec: number,
    origDurationSec: number,
  ) {
    if (!editMode || !onResizeNote) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({
      kind: "resize",
      side,
      layerId,
      index,
      startX: e.clientX,
      origStartSec,
      origDurationSec,
    });
  }

  // ---- pointer move / up は window 全体で拾う ------------------------------
  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      if (drag.kind === "move") {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        const moved =
          drag.moved ||
          Math.abs(dx) > CLICK_THRESHOLD_PX ||
          Math.abs(dy) > CLICK_THRESHOLD_PX;
        if (moved && onMoveNotes) {
          const snapEnabled = !e.altKey;
          const rawDeltaSec = dx / PX_PER_SEC;
          const deltaSec = snapEnabled
            ? snapSec(rawDeltaSec, true) // 0 から見たグリッド単位
            : rawDeltaSec;
          const deltaMidi = -Math.round(dy / ROW_HEIGHT);
          // 増分ではなく毎フレーム「初期位置からの差分」を渡す。
          // ただし onMoveNotes は毎回累積するのではなく
          // ストアから「オリジナル位置」を覚えていないと壊れる。
          // 本実装では毎フレーム選択ノートに deltaSec/deltaMidi を加算する代わりに
          // 「直前フレームからの差分」を計算して渡す。
          // → そのために `lastDelta` を closure で保持する。
          const last = lastDeltaRef.current;
          const stepSec = deltaSec - last.sec;
          const stepMidi = deltaMidi - last.midi;
          if (stepSec !== 0 || stepMidi !== 0) {
            onMoveNotes(drag.selections, stepSec, stepMidi);
            lastDeltaRef.current = { sec: deltaSec, midi: deltaMidi };
          }
        }
        if (moved && !drag.moved) {
          setDrag({ ...drag, moved: true });
        }
        return;
      }
      if (drag.kind === "resize" && onResizeNote) {
        const dx = e.clientX - drag.startX;
        const snapEnabled = !e.altKey;
        const rawDeltaSec = dx / PX_PER_SEC;
        const deltaSec = snapEnabled
          ? snapSec(rawDeltaSec, true)
          : rawDeltaSec;
        if (drag.side === "right") {
          const newDur = Math.max(0.05, drag.origDurationSec + deltaSec);
          onResizeNote(drag.layerId, drag.index, newDur, "right");
        } else {
          // 左端: 終端を固定したまま start を動かす
          // start が動く分 duration は逆方向に変化
          const newDur = Math.max(0.05, drag.origDurationSec - deltaSec);
          onResizeNote(drag.layerId, drag.index, newDur, "left");
        }
        return;
      }
      if (drag.kind === "marquee") {
        const pt = svgPoint(e.clientX, e.clientY);
        if (!pt) return;
        setDrag({ ...drag, curX: pt.x, curY: pt.y });
        // 矩形に入ったノートを選択
        const x1 = Math.min(drag.startX, pt.x);
        const x2 = Math.max(drag.startX, pt.x);
        const y1 = Math.min(drag.startY, pt.y);
        const y2 = Math.max(drag.startY, pt.y);
        const inRect = new Set<SelKey>();
        // pitch 帯
        for (const { id, layer } of layers) {
          layer.notes.forEach((n, i) => {
            const nx1 = n.startSec * PX_PER_SEC;
            const nx2 = nx1 + Math.max(2, n.durationSec * PX_PER_SEC);
            const ny1 = noteY(n.midi);
            const ny2 = ny1 + Math.max(2, ROW_HEIGHT - 1);
            if (nx2 >= x1 && nx1 <= x2 && ny2 >= y1 && ny1 <= y2) {
              inRect.add(selKey(id, i));
            }
          });
        }
        // ドラム帯
        drum.notes.forEach((n, i) => {
          const kind = drumKindOf(n.midi);
          if (!kind) return;
          const nx1 = n.startSec * PX_PER_SEC;
          const nx2 = nx1 + Math.max(6, n.durationSec * PX_PER_SEC);
          const ny1 = drumLaneY(kind) + 2;
          const ny2 = ny1 + DRUM_LANE_HEIGHT - 4;
          if (nx2 >= x1 && nx1 <= x2 && ny2 >= y1 && ny1 <= y2) {
            inRect.add(selKey("drum", i));
          }
        });
        if (drag.additive) {
          const merged = new Set(drag.origSelection);
          inRect.forEach((k) => merged.add(k));
          setSelection(merged);
        } else {
          setSelection(inRect);
        }
        return;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (drag.kind === "move") {
        if (!drag.moved) {
          // 動かさなかった → 単発クリック扱い: clickTarget があれば削除
          const target = drag.clickTarget;
          if (target && onDeleteNote) {
            onDeleteNote(target.layerId, target.index);
            setSelection(new Set());
          }
        }
        lastDeltaRef.current = { sec: 0, midi: 0 };
      } else if (drag.kind === "marquee") {
        const dx = Math.abs(drag.curX - drag.startX);
        const dy = Math.abs(drag.curY - drag.startY);
        if (
          dx < CLICK_THRESHOLD_PX &&
          dy < CLICK_THRESHOLD_PX &&
          onAddNote &&
          armedLayer
        ) {
          // 動かさなかった → クリック扱い: ノート追加
          const pt = svgPoint(e.clientX, e.clientY);
          if (pt) {
            const sec = snapSec(Math.max(0, pt.x / PX_PER_SEC), !e.altKey);
            if (pt.y < DRUM_TOTAL_HEIGHT) {
              const laneIdx = Math.floor(pt.y / DRUM_LANE_HEIGHT);
              const lane = DRUM_LANES[laneIdx];
              if (lane) onAddNote("drum", lane.midi, sec);
            } else if (armedLayer !== "drum") {
              const yInPitch = pt.y - pitchTop;
              const row = Math.floor(yInPitch / ROW_HEIGHT);
              const midi = pitchMax - row;
              if (midi >= pitchMin && midi <= pitchMax) {
                onAddNote(armedLayer, midi, sec);
              }
            }
            // 追加直後はインデックスがずれる可能性があるので選択クリア
            setSelection(new Set());
          }
        }
      }
      setDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, onMoveNotes, onResizeNote, onDeleteNote, onAddNote, armedLayer, layers, drum.notes]);

  // 移動中の累積デルタを保持。pointerup でリセット。
  const lastDeltaRef = useRef<{ sec: number; midi: number }>({ sec: 0, midi: 0 });

  // ---- キーボード: Delete / Backspace で一括削除、Esc で選択解除 ----------
  useEffect(() => {
    if (!editMode) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      if (e.key === "Escape") {
        if (selection.size > 0) {
          e.preventDefault();
          setSelection(new Set());
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selection.size > 0 && onDeleteNotes) {
          e.preventDefault();
          onDeleteNotes([...selection].map(parseSel));
          setSelection(new Set());
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, selection, onDeleteNotes]);

  // ---- レンダリングヘルパ ---------------------------------------------------
  function isSelected(layerId: LayerId, index: number): boolean {
    return selection.has(selKey(layerId, index));
  }

  function renderPitchNote(
    layerId: LayerId,
    n: { midi: number; startSec: number; durationSec: number },
    i: number,
    color: string,
    opacity: number,
  ) {
    const w = Math.max(2, n.durationSec * PX_PER_SEC - 1);
    const x = n.startSec * PX_PER_SEC;
    const y = noteY(n.midi);
    const h = Math.max(2, ROW_HEIGHT - 1);
    const sel = isSelected(layerId, i);
    const handleW = Math.min(RESIZE_HANDLE_WIDTH, w / 2);
    return (
      <g key={`${layerId}-${i}-${n.midi}-${n.startSec}`}>
        <rect
          data-note={layerId}
          x={x}
          y={y}
          width={w}
          height={h}
          fill={color}
          opacity={opacity}
          rx={1}
          style={editMode ? { cursor: "grab" } : undefined}
          onPointerDown={(e) => handleNotePointerDown(e, layerId, i)}
        />
        {sel && (
          <rect
            x={x - 0.5}
            y={y - 0.5}
            width={w + 1}
            height={h + 1}
            fill="none"
            stroke={SELECTION_OUTLINE}
            strokeWidth={1}
            pointerEvents="none"
          />
        )}
        {editMode && onResizeNote && (
          <>
            <rect
              data-resize={`${layerId}-left`}
              x={x}
              y={y}
              width={handleW}
              height={h}
              fill="#fff"
              fillOpacity={0.001}
              style={{ cursor: "ew-resize" }}
              onPointerDown={(e) =>
                handleResizePointerDown(
                  e,
                  layerId,
                  i,
                  "left",
                  n.startSec,
                  n.durationSec,
                )
              }
            />
            <rect
              data-resize={`${layerId}-right`}
              x={x + Math.max(0, w - handleW)}
              y={y}
              width={handleW}
              height={h}
              fill="#fff"
              fillOpacity={0.001}
              style={{ cursor: "ew-resize" }}
              onPointerDown={(e) =>
                handleResizePointerDown(
                  e,
                  layerId,
                  i,
                  "right",
                  n.startSec,
                  n.durationSec,
                )
              }
            />
          </>
        )}
      </g>
    );
  }

  // ---- マーキー矩形の描画情報 -----------------------------------------------
  const marqueeRect =
    drag && drag.kind === "marquee"
      ? {
          x: Math.min(drag.startX, drag.curX),
          y: Math.min(drag.startY, drag.curY),
          w: Math.abs(drag.curX - drag.startX),
          h: Math.abs(drag.curY - drag.startY),
        }
      : null;

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
            style={{ backgroundColor: COLOR_BASS }}
          />
          ベース ({bass.notes.length})
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ backgroundColor: COLOR_SYNTH }}
          />
          シンセ ({synth.notes.length})
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ backgroundColor: COLOR_GUITAR }}
          />
          ギター ({guitar.notes.length})
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
        {editMode && selection.size > 0 && (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-700">
            {selection.size} 個選択中 (Delete=削除 / Esc=解除)
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
                  : recordingLayerId === "bass"
                    ? "🎸 ベース層を録音中"
                    : recordingLayerId === "synth"
                      ? "🎹 シンセ層を録音中"
                      : recordingLayerId === "guitar"
                        ? "🎸 ギター層を録音中"
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
          ref={svgRef}
          width={width}
          height={totalHeight + 22}
          style={{
            display: "block",
            cursor: editMode ? "crosshair" : "default",
            touchAction: editMode ? "none" : "pan-x",
          }}
          onPointerDown={handleSvgPointerDown}
        >
          {/* ドラムレーン背景 */}
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

          {/* 拍グリッド */}
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

          {/* 秒目盛り (BPM 未指定時のみ縦線も引く) */}
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

          {/* C ライン */}
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

          {/* ドラムノート */}
          {drum.notes.map((n, i) => {
            const kind = drumKindOf(n.midi);
            if (!kind) return null;
            const lane = DRUM_LANES.find((l) => l.kind === kind);
            if (!lane) return null;
            const w = Math.max(6, n.durationSec * PX_PER_SEC);
            const x = n.startSec * PX_PER_SEC;
            const y = drumLaneY(kind) + 2;
            const h = DRUM_LANE_HEIGHT - 4;
            const sel = isSelected("drum", i);
            return (
              <g key={`d${i}-${n.midi}-${n.startSec}`}>
                <rect
                  data-note="drum"
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  fill={lane.color}
                  opacity={0.9}
                  rx={2}
                  style={editMode ? { cursor: "grab" } : undefined}
                  onPointerDown={(e) => handleNotePointerDown(e, "drum", i)}
                />
                {sel && (
                  <rect
                    x={x - 0.5}
                    y={y - 0.5}
                    width={w + 1}
                    height={h + 1}
                    fill="none"
                    stroke={SELECTION_OUTLINE}
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                )}
              </g>
            );
          })}

          {/* pitch 帯ノート (背面〜前面の順に重ねる) */}
          {layers.map(({ id, layer, color, opacity }) =>
            layer.notes.map((n, i) =>
              renderPitchNote(id, n, i, color, opacity),
            ),
          )}

          {/* マーキー矩形 */}
          {marqueeRect && (
            <rect
              x={marqueeRect.x}
              y={marqueeRect.y}
              width={marqueeRect.w}
              height={marqueeRect.h}
              fill={SELECTION_OUTLINE}
              fillOpacity={0.12}
              stroke={SELECTION_OUTLINE}
              strokeWidth={1}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          )}

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
