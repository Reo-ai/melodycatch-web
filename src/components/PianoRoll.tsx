/**
 * DAW 風ピアノロール表示。
 *
 * - ドラム層 (上部 3 レーン: Hi-Hat / Snare / Kick) +
 *   メロディ / コード / ベース / シンセ / ギター を同じタイムライン上に重ねて描画
 * - 横軸: 時間。BPM があるときは Cubase 風の「小節番号」(1, 2, 3, …) と拍ティックで表示。
 *   BPM 未指定時のみ秒で表示。
 * - 配色は DAW 風のダーク (背景=黒、グリッド/文字=白系)。
 * - BPM 指定時は小節グリッドにスナップ (デフォルト 1/4 = 拍)。Cmd / Ctrl 押下で一時無効化。
 * - 録音 / 再生中は赤 or 水色の再生ヘッドが進み、自動スクロールで追尾する
 *
 * 編集モード操作 (editMode = true のとき):
 *   - 空エリアをクリック     → armedLayer に新規ノート追加 (スナップあり)
 *   - 空エリアをドラッグ     → 矩形範囲選択 (中に入った全ノートを選択)
 *   - ノート本体をドラッグ   → そのノートを (時間 + ピッチ) ともに自由移動
 *                              選択中なら選択中の全ノートを一緒に移動
 *   - ノート右端ドラッグ     → 終端を伸縮 (右側 RESIZE)
 *   - ノート左端ドラッグ     → 始端を伸縮 (左側 RESIZE — 終端固定)
 *                              範囲選択中なら、選択中のノート全てが同じ量だけ伸縮
 *   - Shift+クリック         → 選択へ追加 / 解除
 *   - Delete / Backspace     → 選択中のノートを一括削除
 *   - Esc                    → 選択クリア
 *   - Cmd / Ctrl 押しながら   → スナップを一時無効化 (自由位置で配置可能)
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
  /** ノート端ドラッグ → 長さ変更 (単発)。side="left" のときは始端、"right" のときは終端を動かす。 */
  onResizeNote?: (
    layerId: LayerId,
    index: number,
    durationSec: number,
    side?: "right" | "left",
  ) => void;
  /** 選択中のノートを一括リサイズ。targets は各ノートのオリジナル位置・長さ。 */
  onResizeNotes?: (
    targets: {
      layerId: LayerId;
      index: number;
      origStartSec: number;
      origDurationSec: number;
    }[],
    deltaSec: number,
    side: "left" | "right",
  ) => void;
  /** 範囲選択 → 一括削除 */
  onDeleteNotes?: (selections: { layerId: LayerId; index: number }[]) => void;
  /** ノート/範囲移動 → (deltaSec, deltaMidi) でずらす */
  onMoveNotes?: (
    selections: { layerId: LayerId; index: number }[],
    deltaSec: number,
    deltaMidi: number,
  ) => void;
  /** 上部ルーラ (再生バー) をクリック / ドラッグ → 指定秒へシーク */
  onSeek?: (sec: number) => void;
}

const BASE_pxPerSec = 64;
const BASE_rowHeight = 5;
const ZOOM_X_MIN = 0.25;
const ZOOM_X_MAX = 6;
/** SVG の最大幅 (px)。Safari の SVG 幅上限 (~16384px) を考慮した安全値。
 *  これを超えると iOS / macOS Safari で右端が描画されない不具合が出るので、
 *  100 小節 × pxPerSec が SAFE_MAX_SVG_WIDTH を超える場合は自動的に
 *  小節数 (= minBars 秒) を縮めて、SVG が常に SAFE_MAX_SVG_WIDTH 以内に収まるようにする。 */
const SAFE_MAX_SVG_WIDTH = 16000;
/** 右端見切れ防止用の追加パディング (px)。 */
const RIGHT_PAD_PX = 48;
/** 標準で見せたい小節数。100 小節をターゲットにするが、
 *  SAFE_MAX_SVG_WIDTH を超えるときは縮める。 */
const TARGET_BARS = 100;
const ZOOM_Y_MIN = 0.6;
const ZOOM_Y_MAX = 4;
const ZOOM_X_STEP = 1.25;
const ZOOM_Y_STEP = 1.2;
const PITCH_PAD = 2;
const MIN_PITCH_RANGE = 18;
const MIN_DURATION_SEC = 8;

/** 上部の Cubase 風タイムルーラ高さ。再生バー + 小節番号を描く。 */
const TOP_RULER_HEIGHT = 22;
const DRUM_LANE_HEIGHT = 16;
const DRUM_LANES: { kind: DrumKind; midi: number; label: string; color: string }[] = [
  { kind: "hihat", midi: DRUM_HIHAT_MIDI, label: "HiHat", color: "#facc15" },
  { kind: "snare", midi: DRUM_SNARE_MIDI, label: "Snare", color: "#22c55e" },
  { kind: "kick", midi: DRUM_KICK_MIDI, label: "Kick", color: "#a855f7" },
];
const DRUM_TOTAL_HEIGHT = DRUM_LANES.length * DRUM_LANE_HEIGHT;
const DRUM_PITCH_GAP = 4;

// ダーク DAW 配色
const COLOR_BG = "#0b1020";
const COLOR_LANE_A = "#161c2e";
const COLOR_LANE_B = "#1b2238";
const COLOR_DIVIDER = "#cbd5e1";
const COLOR_GRID_BAR = "#cbd5e1"; // 小節線 (太・明るい)
const COLOR_GRID_BEAT = "#475569"; // 拍線
const COLOR_GRID_SUB = "#334155"; // 細分線
const COLOR_C_LINE = "#64748b";
const COLOR_LABEL = "#e2e8f0";
const COLOR_LABEL_SUB = "#94a3b8";
const COLOR_RULER_BG = "#0f172a";

const COLOR_MELODY = "#fb923c";
const COLOR_CHORD = "#818cf8";
const COLOR_BASS = "#2dd4bf";
const COLOR_SYNTH = "#f472b6";
const COLOR_GUITAR = "#fbbf24";
const COLOR_REC = "#ef4444";
const COLOR_PLAY = "#38bdf8";
/** 端を掴むためのつまみ幅 (px)。短いノートでは自動的に半分以下に縮める。 */
const RESIZE_HANDLE_WIDTH = 6;
/** 移動と単発クリック (削除) を区別する閾値 (px)。これ未満で離せばクリック扱い。 */
const CLICK_THRESHOLD_PX = 4;
/** 選択中のノートを示すアウトライン色 */
const SELECTION_OUTLINE = "#38bdf8";

/** Cmd / Ctrl 押下中はスナップを一時的に無効化する。 */
function isSnapBypass(e: PointerEvent | ReactPointerEvent | KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

/** MIDI 番号 → "C4", "C#4" など。半音含む全音名表記。 */
const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F",
  "F#", "G", "G#", "A", "A#", "B",
];
function midiToName(midi: number): string {
  const oct = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${oct}`;
}
/** ピアノで黒鍵 (C#, D#, F#, G#, A#) かどうか。 */
function isBlackKey(midi: number): boolean {
  const m = ((midi % 12) + 12) % 12;
  return m === 1 || m === 3 || m === 6 || m === 8 || m === 10;
}

/** 1 小節 = 4 拍 (4/4 を仮定)。BPM=120 なら 2.0s, BPM=90 なら 2.667s。 */
const BEATS_PER_BAR = 4;
function barSecOf(bpm: number): number {
  const beat = 60 / Math.max(1, bpm);
  return beat * BEATS_PER_BAR;
}

type SnapDiv = "1/1" | "1/2" | "1/4" | "1/8" | "1/16" | "off";
const SNAP_OPTIONS: { value: SnapDiv; label: string; help: string }[] = [
  { value: "1/1", label: "1 小節", help: "小節の頭にスナップ" },
  { value: "1/2", label: "1/2", help: "小節の半分 = 2 拍" },
  { value: "1/4", label: "1/4 (拍)", help: "1 拍 = 4分音符" },
  { value: "1/8", label: "1/8", help: "8分音符" },
  { value: "1/16", label: "1/16", help: "16分音符" },
  { value: "off", label: "スナップ OFF", help: "自由位置" },
];

/** SnapDiv → 1 単位の長さ (秒)。BPM 未指定時は 0 (=スナップなし)。 */
function snapUnitOf(div: SnapDiv, bpm?: number): number {
  if (div === "off" || !bpm) return 0;
  const bar = barSecOf(bpm);
  switch (div) {
    case "1/1":
      return bar;
    case "1/2":
      return bar / 2;
    case "1/4":
      return bar / 4;
    case "1/8":
      return bar / 8;
    case "1/16":
      return bar / 16;
  }
}

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
  /** drag 開始時のアンカー (= 押下されたノート) の元の startSec / midi。
   *  これを基に「絶対位置をスナップ」して、deltaSec を逆算する。 */
  anchorOrigStartSec: number;
  anchorOrigMidi: number;
  /** ドラッグ開始時にすでに選択されていなかった場合 (= 単発ノートをドラッグ)、
   *  クリック扱いになったときに削除すべきか判定するためのターゲット */
  clickTarget?: { layerId: LayerId; index: number };
  moved: boolean;
}

interface ResizeTarget {
  layerId: LayerId;
  index: number;
  origStartSec: number;
  origDurationSec: number;
}

interface ResizeDrag {
  kind: "resize";
  side: "left" | "right";
  startX: number;
  /** 単発リサイズの場合は length=1、範囲選択中なら全選択ノート。 */
  targets: ResizeTarget[];
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
  onResizeNotes,
  onDeleteNotes,
  onMoveNotes,
  onSeek,
}: PianoRollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<SVGLineElement>(null);
  const playheadMarkerRef = useRef<SVGPolygonElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  /** 上部ルーラのドラッグ中フラグ */
  const seekDraggingRef = useRef(false);

  const [selection, setSelection] = useState<Set<SelKey>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  // BPM があれば 1/4 (拍) 単位がデフォルト。なければ off。
  const [snapDiv, setSnapDiv] = useState<SnapDiv>("1/4");
  // ズーム倍率 (X=横/時間, Y=縦/ピッチ)。1.0 が等倍。
  const [zoomX, setZoomX] = useState(1);
  const [zoomY, setZoomY] = useState(1);
  const pxPerSec = BASE_pxPerSec * zoomX;
  const rowHeight = BASE_rowHeight * zoomY;

  // 編集モードを抜けたら選択クリア
  useEffect(() => {
    if (!editMode) {
      setSelection(new Set());
      setDrag(null);
    }
  }, [editMode]);

  // 初回マウント時に左端 (時刻 0) を表示するようにスクロール位置を初期化。
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ズーム適用 (X)。anchorClientX を中心に拡大して、スクロール位置を補正。 */
  function applyZoomX(factor: number, anchorClientX?: number) {
    const el = scrollRef.current;
    const oldZoom = zoomX;
    const next = Math.max(ZOOM_X_MIN, Math.min(ZOOM_X_MAX, oldZoom * factor));
    if (next === oldZoom) return;
    if (el && anchorClientX !== undefined) {
      const rect = el.getBoundingClientRect();
      const localX = anchorClientX - rect.left + el.scrollLeft;
      const ratio = next / oldZoom;
      const newLocalX = localX * ratio;
      const newScrollLeft = newLocalX - (anchorClientX - rect.left);
      // 反映は次フレーム (state 更新と同期)
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollLeft = Math.max(0, newScrollLeft);
        }
      });
    }
    setZoomX(next);
  }

  /** ズーム適用 (Y)。anchorClientY を中心に拡大して、スクロール位置を補正。 */
  function applyZoomY(factor: number, anchorClientY?: number) {
    const el = scrollRef.current;
    const oldZoom = zoomY;
    const next = Math.max(ZOOM_Y_MIN, Math.min(ZOOM_Y_MAX, oldZoom * factor));
    if (next === oldZoom) return;
    if (el && anchorClientY !== undefined) {
      const rect = el.getBoundingClientRect();
      const localY = anchorClientY - rect.top + el.scrollTop;
      const ratio = next / oldZoom;
      const newLocalY = localY * ratio;
      const newScrollTop = newLocalY - (anchorClientY - rect.top);
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = Math.max(0, newScrollTop);
        }
      });
    }
    setZoomY(next);
  }

  function resetZoom() {
    setZoomX(1);
    setZoomY(1);
  }

  // Cmd / Ctrl + ホイール: 横ズーム。Cmd / Ctrl + Shift + ホイール: 縦ズーム。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_X_STEP : 1 / ZOOM_X_STEP;
      if (e.shiftKey) {
        applyZoomY(factor, e.clientY);
      } else {
        applyZoomX(factor, e.clientX);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomX, zoomY]);

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
    // 標準で TARGET_BARS (=100) 小節分の余白を確保する。
    // ただし `pxPerSec * TARGET_BARS * barSec` が SAFE_MAX_SVG_WIDTH を超えると
    // Safari で SVG 右端が描画されなくなるため、収まる範囲まで小節数を自動縮小する。
    // bpm が 0/undefined でも必ず確保するために ?? 100 でフォールバック。
    const barSec = barSecOf(bpm ?? 100);
    const idealMinBarsSec = TARGET_BARS * barSec;
    const maxAffordableSec = Math.max(
      barSec * 8, // 最低 8 小節は確保
      (SAFE_MAX_SVG_WIDTH - RIGHT_PAD_PX) / Math.max(1, pxPerSec),
    );
    const minBars = Math.min(idealMinBarsSec, maxAffordableSec);
    // 末尾に余白 (右端見切れ対策) として 1 小節 + 1.5 秒を加える。
    const trailing = barSec + 1.5;
    const tot = Math.max(minBars, last + trailing, MIN_DURATION_SEC);
    return {
      width: tot * pxPerSec + RIGHT_PAD_PX,
      pitchHeight: (pMax - pMin + 1) * rowHeight,
      pitchMin: pMin,
      pitchMax: pMax,
      totalSec: tot,
    };
  }, [melody.notes, chord.notes, drum.notes, bass.notes, synth.notes, guitar.notes, pxPerSec, rowHeight, bpm]);

  const drumTop = TOP_RULER_HEIGHT;
  const pitchTop = TOP_RULER_HEIGHT + DRUM_TOTAL_HEIGHT + DRUM_PITCH_GAP;
  const totalHeight = pitchTop + pitchHeight;

  function noteY(midi: number): number {
    return pitchTop + (pitchMax - midi) * rowHeight;
  }

  function drumLaneY(kind: DrumKind): number {
    const idx = DRUM_LANES.findIndex((l) => l.kind === kind);
    return drumTop + idx * DRUM_LANE_HEIGHT;
  }

  /** snapEnabled なら現在のスナップ単位にスナップ。Cmd/Ctrl 押下中は呼び元で false にすること。 */
  function snapSec(sec: number, snapEnabled: boolean): number {
    if (!snapEnabled) return sec;
    const unit = snapUnitOf(snapDiv, bpm);
    if (unit <= 0) return sec;
    return Math.round(sec / unit) * unit;
  }

  // 再生ヘッド rAF ループ。再生 / 録音中に限らず常時走らせ、
  // 停止中は seek 位置を表示する。自動スクロール追尾は isActive のときだけ。
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const sec = getPlayheadSec();
      const x = sec * pxPerSec;
      if (playheadRef.current) {
        playheadRef.current.setAttribute("x1", String(x));
        playheadRef.current.setAttribute("x2", String(x));
      }
      if (playheadMarkerRef.current) {
        playheadMarkerRef.current.setAttribute(
          "transform",
          `translate(${x}, 0)`,
        );
      }
      // 再生バーが画面外に出たら追尾。再生中だけでなく seek 中も追尾する。
      // ただし上部ルーラを掴んでドラッグ中はユーザの操作を妨げないよう一時停止。
      if (!seekDraggingRef.current) {
        const el = scrollRef.current;
        if (el) {
          const right = el.scrollLeft + el.clientWidth;
          if (x > right - 100) {
            el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
          } else if (x < el.scrollLeft + 40) {
            el.scrollLeft = Math.max(0, x - 40);
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isActive, getPlayheadSec, pxPerSec]);

  // 拍 / 小節グリッド (BPM 指定時のみ)
  // 描画分解能は現在のスナップ単位に合わせる (off の場合は拍だけ)。
  const gridLines = useMemo(() => {
    if (!bpm) return [] as { sec: number; kind: "bar" | "beat" | "sub" }[];
    const beat = 60 / bpm;
    const bar = beat * BEATS_PER_BAR;
    const subUnit = snapUnitOf(snapDiv, bpm);
    const out: { sec: number; kind: "bar" | "beat" | "sub" }[] = [];
    // 小節線
    for (let s = 0; s <= totalSec + 0.0001; s += bar) {
      out.push({ sec: s, kind: "bar" });
    }
    // 拍線
    for (let s = 0; s <= totalSec + 0.0001; s += beat) {
      // 小節線と重なる位置はスキップ (描画コスト削減)
      if (Math.abs((s / bar) - Math.round(s / bar)) < 1e-6) continue;
      out.push({ sec: s, kind: "beat" });
    }
    // 細分線 (1/8, 1/16 などスナップが拍より細かいとき)
    if (subUnit > 0 && subUnit < beat - 1e-6) {
      for (let s = 0; s <= totalSec + 0.0001; s += subUnit) {
        // 拍 / 小節の位置はスキップ
        if (Math.abs((s / beat) - Math.round(s / beat)) < 1e-6) continue;
        out.push({ sec: s, kind: "sub" });
      }
    }
    return out;
  }, [bpm, totalSec, snapDiv]);

  // 小節番号 (BPM 指定時)
  const barNumbers = useMemo(() => {
    if (!bpm) return [] as { sec: number; n: number }[];
    const bar = barSecOf(bpm);
    const out: { sec: number; n: number }[] = [];
    for (let i = 0; i * bar <= totalSec + 0.0001; i++) {
      out.push({ sec: i * bar, n: i + 1 }); // Cubase 風: 1 始まり
    }
    return out;
  }, [bpm, totalSec]);

  // 秒目盛り (BPM 未指定時のフォールバック)
  const secTicks: number[] = [];
  if (!bpm) {
    for (let s = 0; s <= Math.ceil(totalSec); s++) secTicks.push(s);
  }

  // 全 MIDI ピッチ (C, C#, D, ...) のリスト。グリッド線+ラベルに使う。
  const allPitches: number[] = [];
  for (let p = pitchMax; p >= pitchMin; p--) allPitches.push(p);
  // ラベルは行高が小さい時は C のみ、大きい時は全音表示する。
  const showAllLabels = rowHeight >= 7;

  const playheadColor = recordingLayerId ? COLOR_REC : COLOR_PLAY;

  // ---- レイヤごとのノート取得ヘルパ -----------------------------------------
  const layers: { id: LayerId; layer: Layer; color: string; opacity: number }[] = [
    { id: "bass", layer: bass, color: COLOR_BASS, opacity: 0.85 },
    { id: "chord", layer: chord, color: COLOR_CHORD, opacity: 0.85 },
    { id: "synth", layer: synth, color: COLOR_SYNTH, opacity: 0.9 },
    { id: "guitar", layer: guitar, color: COLOR_GUITAR, opacity: 0.9 },
    { id: "melody", layer: melody, color: COLOR_MELODY, opacity: 0.95 },
  ];

  // Layer ID から Layer を引く
  function layerOf(id: LayerId): Layer {
    switch (id) {
      case "melody":
        return melody;
      case "chord":
        return chord;
      case "drum":
        return drum;
      case "bass":
        return bass;
      case "synth":
        return synth;
      case "guitar":
        return guitar;
    }
  }

  // ---- SVG 座標変換 ---------------------------------------------------------
  function svgPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /** 上部ルーラのクリック / ドラッグでシーク。 */
  function seekFromClient(clientX: number) {
    if (!onSeek) return;
    const pt = svgPoint(clientX, 0);
    if (!pt) return;
    const sec = Math.max(0, pt.x / pxPerSec);
    // スナップが ON なら拍/小節にスナップ
    const snapped = snapSec(sec, snapDiv !== "off");
    onSeek(Math.max(0, snapped));
  }

  function handleTopRulerPointerDown(e: ReactPointerEvent) {
    if (!onSeek) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    seekDraggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    seekFromClient(e.clientX);
  }
  function handleTopRulerPointerMove(e: ReactPointerEvent) {
    if (!seekDraggingRef.current) return;
    seekFromClient(e.clientX);
  }
  function handleTopRulerPointerUp(e: ReactPointerEvent) {
    if (!seekDraggingRef.current) return;
    seekDraggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  // ---- 編集モード: 空エリア pointer down ------------------------------------
  function handleSvgPointerDown(e: ReactPointerEvent) {
    if (!editMode) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if ((e.target as Element).closest("[data-note]")) return; // ノート押下は別ハンドラ
    if ((e.target as Element).closest("[data-resize]")) return;

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
      activeSelection = new Set(selection);
      if (activeSelection.has(key)) activeSelection.delete(key);
      else activeSelection.add(key);
    } else if (selection.has(key)) {
      activeSelection = new Set(selection);
    } else {
      activeSelection = new Set([key]);
    }
    setSelection(activeSelection);

    (e.target as Element).setPointerCapture?.(e.pointerId);

    // アンカー (= 押下されたノート) の元の位置をスナップ計算用に保持
    const anchorLayer = layerOf(layerId);
    const anchorNote = anchorLayer.notes[index];
    const anchorOrigStartSec = anchorNote ? anchorNote.startSec : 0;
    const anchorOrigMidi = anchorNote ? anchorNote.midi : 60;

    setDrag({
      kind: "move",
      startX: e.clientX,
      startY: e.clientY,
      selections: [...activeSelection].map(parseSel),
      anchorOrigStartSec,
      anchorOrigMidi,
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
    if (!editMode) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);

    // 範囲選択中で、リサイズ対象が選択に含まれているなら、選択中の全ノートを一括リサイズ。
    const key = selKey(layerId, index);
    const isMulti = selection.size > 1 && selection.has(key) && !!onResizeNotes;
    let targets: ResizeTarget[];
    if (isMulti) {
      targets = [...selection].map(parseSel).map((s) => {
        const l = layerOf(s.layerId);
        const n = l.notes[s.index];
        return {
          layerId: s.layerId,
          index: s.index,
          origStartSec: n ? n.startSec : 0,
          origDurationSec: n ? n.durationSec : 0,
        };
      });
    } else {
      targets = [{ layerId, index, origStartSec, origDurationSec }];
    }

    setDrag({
      kind: "resize",
      side,
      startX: e.clientX,
      targets,
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
          const snapEnabled = !isSnapBypass(e);
          const rawDeltaSec = dx / pxPerSec;
          // 絶対位置スナップ: アンカーの新しい startSec をグリッドに合わせ、
          // そこから deltaSec を逆算する → 全選択ノートが「相対位置を保ったまま
          // アンカーがグリッドに合う」形で動く。
          const newAnchorAbs = drag.anchorOrigStartSec + rawDeltaSec;
          const snappedAnchorAbs = snapEnabled
            ? Math.max(0, snapSec(newAnchorAbs, true))
            : newAnchorAbs;
          const deltaSec = snappedAnchorAbs - drag.anchorOrigStartSec;
          const deltaMidi = -Math.round(dy / rowHeight);
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
      if (drag.kind === "resize") {
        const dx = e.clientX - drag.startX;
        const snapEnabled = !isSnapBypass(e);
        const rawDeltaSec = dx / pxPerSec;
        // 絶対位置スナップ: アンカー (= 最初の対象) のリサイズ対象エッジを
        // 直接小節 / 拍ラインにスナップさせ、その deltaSec を全ターゲットに適用する。
        // これにより「ノートの長さの端が小節線にぴったり合う」挙動になる。
        const anchor = drag.targets[0];
        const anchorOrigEdge =
          drag.side === "right"
            ? anchor.origStartSec + anchor.origDurationSec
            : anchor.origStartSec;
        const newAnchorEdgeAbs = anchorOrigEdge + rawDeltaSec;
        const snappedAnchorEdgeAbs = snapEnabled
          ? Math.max(0, snapSec(newAnchorEdgeAbs, true))
          : newAnchorEdgeAbs;
        const deltaSec = snappedAnchorEdgeAbs - anchorOrigEdge;
        // 一括リサイズ: targets 全部に同じ delta を当てる
        if (drag.targets.length > 1 && onResizeNotes) {
          onResizeNotes(drag.targets, deltaSec, drag.side);
        } else if (onResizeNote) {
          // 単発: 既存の onResizeNote を維持 (互換)
          const t = drag.targets[0];
          if (drag.side === "right") {
            const newDur = Math.max(0.05, t.origDurationSec + deltaSec);
            onResizeNote(t.layerId, t.index, newDur, "right");
          } else {
            const newDur = Math.max(0.05, t.origDurationSec - deltaSec);
            onResizeNote(t.layerId, t.index, newDur, "left");
          }
        }
        return;
      }
      if (drag.kind === "marquee") {
        const pt = svgPoint(e.clientX, e.clientY);
        if (!pt) return;
        setDrag({ ...drag, curX: pt.x, curY: pt.y });
        const x1 = Math.min(drag.startX, pt.x);
        const x2 = Math.max(drag.startX, pt.x);
        const y1 = Math.min(drag.startY, pt.y);
        const y2 = Math.max(drag.startY, pt.y);
        const inRect = new Set<SelKey>();
        for (const { id, layer } of layers) {
          layer.notes.forEach((n, i) => {
            const nx1 = n.startSec * pxPerSec;
            const nx2 = nx1 + Math.max(2, n.durationSec * pxPerSec);
            const ny1 = noteY(n.midi);
            const ny2 = ny1 + Math.max(2, rowHeight - 1);
            if (nx2 >= x1 && nx1 <= x2 && ny2 >= y1 && ny1 <= y2) {
              inRect.add(selKey(id, i));
            }
          });
        }
        drum.notes.forEach((n, i) => {
          const kind = drumKindOf(n.midi);
          if (!kind) return;
          const nx1 = n.startSec * pxPerSec;
          const nx2 = nx1 + Math.max(6, n.durationSec * pxPerSec);
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
          const pt = svgPoint(e.clientX, e.clientY);
          if (pt) {
            const sec = snapSec(Math.max(0, pt.x / pxPerSec), !isSnapBypass(e));
            // 上部ルーラ領域 (y<TOP_RULER_HEIGHT) はノート追加対象外。
            // ドラムレーンは [TOP_RULER_HEIGHT, TOP_RULER_HEIGHT+DRUM_TOTAL_HEIGHT)
            if (pt.y >= TOP_RULER_HEIGHT && pt.y < TOP_RULER_HEIGHT + DRUM_TOTAL_HEIGHT) {
              const laneIdx = Math.floor((pt.y - TOP_RULER_HEIGHT) / DRUM_LANE_HEIGHT);
              const lane = DRUM_LANES[laneIdx];
              if (lane) onAddNote("drum", lane.midi, sec);
            } else if (armedLayer !== "drum" && pt.y >= pitchTop) {
              const yInPitch = pt.y - pitchTop;
              const row = Math.floor(yInPitch / rowHeight);
              const midi = pitchMax - row;
              if (midi >= pitchMin && midi <= pitchMax) {
                onAddNote(armedLayer, midi, sec);
              }
            }
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
  }, [drag, onMoveNotes, onResizeNote, onResizeNotes, onDeleteNote, onAddNote, armedLayer, layers, drum.notes, snapDiv, bpm, pxPerSec, rowHeight]);

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
    const w = Math.max(2, n.durationSec * pxPerSec - 1);
    const x = n.startSec * pxPerSec;
    const y = noteY(n.midi);
    const h = Math.max(2, rowHeight - 1);
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

  const RULER_HEIGHT = 18;

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
            {bpm} BPM
          </span>
        )}
        {/* スナップ分解能セレクタ (BPM 指定時のみ) */}
        {bpm && (
          <label
            className="flex items-center gap-1"
            title="移動・リサイズ・新規追加のスナップ単位。Cmd / Ctrl 押下中は一時的に無効化されます。"
          >
            <span className="text-ink-500">スナップ:</span>
            <select
              className="rounded border border-ink-300 bg-white px-1 py-0.5 font-mono text-[11px]"
              value={snapDiv}
              onChange={(e) => setSnapDiv(e.target.value as SnapDiv)}
            >
              {SNAP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.help}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* ズームコントロール */}
        <div
          className="flex items-center gap-1"
          title="Cmd/Ctrl + ホイールで横ズーム、Cmd/Ctrl + Shift + ホイールで縦ズーム"
        >
          <span className="text-ink-500">横:</span>
          <button
            type="button"
            className="rounded border border-ink-300 bg-white px-1.5 py-0.5 font-mono text-[11px] hover:bg-ink-100"
            onClick={() => applyZoomX(1 / ZOOM_X_STEP)}
            disabled={zoomX <= ZOOM_X_MIN + 1e-6}
          >
            −
          </button>
          <span className="min-w-[2.5em] text-center font-mono text-[11px] text-ink-600">
            {(zoomX * 100).toFixed(0)}%
          </span>
          <button
            type="button"
            className="rounded border border-ink-300 bg-white px-1.5 py-0.5 font-mono text-[11px] hover:bg-ink-100"
            onClick={() => applyZoomX(ZOOM_X_STEP)}
            disabled={zoomX >= ZOOM_X_MAX - 1e-6}
          >
            +
          </button>
          <span className="ml-2 text-ink-500">縦:</span>
          <button
            type="button"
            className="rounded border border-ink-300 bg-white px-1.5 py-0.5 font-mono text-[11px] hover:bg-ink-100"
            onClick={() => applyZoomY(1 / ZOOM_Y_STEP)}
            disabled={zoomY <= ZOOM_Y_MIN + 1e-6}
          >
            −
          </button>
          <span className="min-w-[2.5em] text-center font-mono text-[11px] text-ink-600">
            {(zoomY * 100).toFixed(0)}%
          </span>
          <button
            type="button"
            className="rounded border border-ink-300 bg-white px-1.5 py-0.5 font-mono text-[11px] hover:bg-ink-100"
            onClick={() => applyZoomY(ZOOM_Y_STEP)}
            disabled={zoomY >= ZOOM_Y_MAX - 1e-6}
          >
            +
          </button>
          <button
            type="button"
            className="ml-1 rounded border border-ink-300 bg-white px-1.5 py-0.5 font-mono text-[11px] hover:bg-ink-100"
            onClick={resetZoom}
            title="ズームを 100% に戻す"
          >
            リセット
          </button>
        </div>
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
        className="overflow-x-auto rounded-xl border border-ink-800 shadow-inner"
        style={{ minHeight: 200, backgroundColor: COLOR_BG }}
      >
        <svg
          ref={svgRef}
          width={width}
          height={totalHeight + RULER_HEIGHT + 4}
          style={{
            display: "block",
            cursor: editMode ? "crosshair" : "default",
            touchAction: editMode ? "none" : "pan-x",
            backgroundColor: COLOR_BG,
          }}
          onPointerDown={handleSvgPointerDown}
        >
          {/* === 上部 Cubase 風タイムルーラ (再生バー) === */}
          <rect
            data-top-ruler="1"
            x={0}
            y={0}
            width={width}
            height={TOP_RULER_HEIGHT}
            fill={COLOR_RULER_BG}
            style={{ cursor: onSeek ? "pointer" : "default" }}
            onPointerDown={handleTopRulerPointerDown}
            onPointerMove={handleTopRulerPointerMove}
            onPointerUp={handleTopRulerPointerUp}
            onPointerCancel={handleTopRulerPointerUp}
          />
          {/* 上部ルーラ下の境界線 */}
          <line
            x1={0}
            y1={TOP_RULER_HEIGHT}
            x2={width}
            y2={TOP_RULER_HEIGHT}
            stroke={COLOR_DIVIDER}
            strokeOpacity={0.4}
            strokeWidth={1}
          />
          {/* 上部ルーラ: 小節番号 + 拍ティック */}
          {bpm
            ? barNumbers.map((b) => (
                <g key={`tbn${b.n}`} pointerEvents="none">
                  <line
                    x1={b.sec * pxPerSec}
                    y1={TOP_RULER_HEIGHT - 8}
                    x2={b.sec * pxPerSec}
                    y2={TOP_RULER_HEIGHT}
                    stroke={COLOR_GRID_BAR}
                    strokeWidth={1}
                    opacity={0.85}
                  />
                  <text
                    x={b.sec * pxPerSec + 3}
                    y={TOP_RULER_HEIGHT - 9}
                    fontSize="11"
                    fill={COLOR_LABEL}
                    fontFamily="ui-monospace, monospace"
                    fontWeight={700}
                  >
                    {b.n}
                  </text>
                </g>
              ))
            : secTicks.map((s) => (
                <g key={`tst${s}`} pointerEvents="none">
                  <line
                    x1={s * pxPerSec}
                    y1={TOP_RULER_HEIGHT - 6}
                    x2={s * pxPerSec}
                    y2={TOP_RULER_HEIGHT}
                    stroke={s % 4 === 0 ? COLOR_GRID_BAR : COLOR_GRID_SUB}
                    strokeWidth={s % 4 === 0 ? 1 : 0.5}
                    opacity={s % 4 === 0 ? 0.7 : 0.4}
                  />
                  <text
                    x={s * pxPerSec + 3}
                    y={TOP_RULER_HEIGHT - 8}
                    fontSize="10"
                    fill={COLOR_LABEL_SUB}
                    fontFamily="ui-monospace, monospace"
                  >
                    {s}s
                  </text>
                </g>
              ))}

          {/* ドラムレーン背景 */}
          {DRUM_LANES.map((lane, idx) => (
            <g key={`dl${lane.kind}`}>
              <rect
                x={0}
                y={drumLaneY(lane.kind)}
                width={width}
                height={DRUM_LANE_HEIGHT}
                fill={idx % 2 === 0 ? COLOR_LANE_A : COLOR_LANE_B}
              />
              <text
                x={4}
                y={drumLaneY(lane.kind) + DRUM_LANE_HEIGHT - 4}
                fontSize="10"
                fill={COLOR_LABEL}
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
            stroke={COLOR_DIVIDER}
            strokeOpacity={0.4}
            strokeWidth={1}
          />

          {/* 拍 / 小節 / 細分グリッド (BPM 指定時) — 上部ルーラの下から */}
          {gridLines.map((g, i) => {
            const stroke =
              g.kind === "bar"
                ? COLOR_GRID_BAR
                : g.kind === "beat"
                  ? COLOR_GRID_BEAT
                  : COLOR_GRID_SUB;
            const sw = g.kind === "bar" ? 1 : g.kind === "beat" ? 0.6 : 0.4;
            const op = g.kind === "bar" ? 0.7 : g.kind === "beat" ? 0.55 : 0.35;
            return (
              <line
                key={`gl${i}-${g.kind}`}
                x1={g.sec * pxPerSec}
                y1={TOP_RULER_HEIGHT}
                x2={g.sec * pxPerSec}
                y2={totalHeight}
                stroke={stroke}
                strokeWidth={sw}
                opacity={op}
              />
            );
          })}

          {/* 秒目盛り (BPM 未指定時のみ縦線も引く) */}
          {!bpm &&
            secTicks.map((s) => (
              <line
                key={`st${s}`}
                x1={s * pxPerSec}
                y1={TOP_RULER_HEIGHT}
                x2={s * pxPerSec}
                y2={totalHeight}
                stroke={s % 4 === 0 ? COLOR_GRID_BAR : COLOR_GRID_SUB}
                strokeWidth={s % 4 === 0 ? 1 : 0.5}
                opacity={s % 4 === 0 ? 0.6 : 0.35}
              />
            ))}

          {/* 黒鍵レーン背景 (C#, D#, F#, G#, A# の行を薄くシェード) */}
          {allPitches.map((p) =>
            isBlackKey(p) ? (
              <rect
                key={`bk${p}`}
                x={0}
                y={noteY(p)}
                width={width}
                height={Math.max(1, rowHeight)}
                fill="#0d1325"
                opacity={0.55}
              />
            ) : null,
          )}
          {/* 全音グリッド線 + ラベル。C 行は太く明るく、半音は細く暗く。 */}
          {allPitches.map((p) => {
            const isC = ((p % 12) + 12) % 12 === 0;
            return (
              <g key={`p${p}`}>
                <line
                  x1={0}
                  y1={noteY(p)}
                  x2={width}
                  y2={noteY(p)}
                  stroke={isC ? COLOR_C_LINE : COLOR_GRID_SUB}
                  strokeWidth={isC ? 1 : 0.4}
                  opacity={isC ? 0.55 : 0.35}
                />
                {(isC || showAllLabels) && (
                  <text
                    x={4}
                    y={noteY(p) + Math.max(8, rowHeight - 1)}
                    fontSize={showAllLabels ? "8" : "9"}
                    fill={isC ? COLOR_LABEL : COLOR_LABEL_SUB}
                    fontFamily="ui-monospace, monospace"
                    fontWeight={isC ? 600 : 400}
                    opacity={isC ? 0.95 : 0.7}
                  >
                    {midiToName(p)}
                  </text>
                )}
              </g>
            );
          })}

          {/* タイムルーラ (下部) — 小節番号 or 秒 */}
          <rect
            x={0}
            y={totalHeight}
            width={width}
            height={RULER_HEIGHT + 4}
            fill={COLOR_RULER_BG}
          />
          {bpm
            ? barNumbers.map((b) => (
                <g key={`bn${b.n}`}>
                  <line
                    x1={b.sec * pxPerSec}
                    y1={totalHeight}
                    x2={b.sec * pxPerSec}
                    y2={totalHeight + 5}
                    stroke={COLOR_GRID_BAR}
                    strokeWidth={1}
                    opacity={0.8}
                  />
                  <text
                    x={b.sec * pxPerSec + 3}
                    y={totalHeight + 14}
                    fontSize="10"
                    fill={COLOR_LABEL}
                    fontFamily="ui-monospace, monospace"
                    fontWeight={600}
                  >
                    {b.n}
                  </text>
                </g>
              ))
            : secTicks.map((s) => (
                <text
                  key={`tt${s}`}
                  x={s * pxPerSec + 3}
                  y={totalHeight + 14}
                  fontSize="10"
                  fill={COLOR_LABEL_SUB}
                  fontFamily="ui-monospace, monospace"
                >
                  {s}s
                </text>
              ))}

          {/* ドラムノート */}
          {drum.notes.map((n, i) => {
            const kind = drumKindOf(n.midi);
            if (!kind) return null;
            const lane = DRUM_LANES.find((l) => l.kind === kind);
            if (!lane) return null;
            const w = Math.max(6, n.durationSec * pxPerSec);
            const x = n.startSec * pxPerSec;
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
              fillOpacity={0.18}
              stroke={SELECTION_OUTLINE}
              strokeWidth={1}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          )}

          {/* 再生ヘッド (縦線) — 常に表示。停止中は seek 位置を示す */}
          <line
            ref={playheadRef}
            x1={0}
            y1={TOP_RULER_HEIGHT}
            x2={0}
            y2={totalHeight}
            stroke={playheadColor}
            strokeWidth={2}
            strokeDasharray={recordingLayerId ? "4 2" : undefined}
            pointerEvents="none"
          />
          {/* 上部ルーラの▼マーカー (Cubase 風) */}
          <polygon
            ref={playheadMarkerRef}
            points={`-6,${TOP_RULER_HEIGHT - 12} 6,${TOP_RULER_HEIGHT - 12} 0,${TOP_RULER_HEIGHT - 1}`}
            fill={playheadColor}
            stroke="#0b1020"
            strokeWidth={0.5}
            pointerEvents="none"
          />
        </svg>
      </div>
    </div>
  );
}
