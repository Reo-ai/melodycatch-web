/**
 * Studio (統合スタジオ画面)。
 *
 * 演奏モードと録音モードを統合したワンスクリーン UI。
 *
 * 構成:
 *   ① キー / スケール
 *   ② ドラムマシン (5 パターン + BPM)
 *   ③ 録音トラック (5 層) — ピアノロールを見ながら操作できるよう上に配置
 *   ④ ピアノロール (DAW 風 / 録音した内容を可視化)
 *   ⑤ 入力カルーセル (コードパレット ↔ スケールミニピアノ ↔ 88鍵ピアノ)
 *   ⑥ 進行プリセット
 *
 * - 録音しなければ「演奏モード」として使えるし、
 *   そのまま録音ボタンを押せば「録音モード」として MIDI 書き出しまでできる。
 * - DAW 風オーバーダブ: 録音中は反対側の層を同時再生。
 * - 入力: ピアノ(タッチ/マウス) + PC キーボード + Web MIDI + コードパレット + 進行プリセット
 *
 * 重要: 録音状態とアーム対象は `stateRef` / `armedRef` 経由で常に最新値で判定する
 * (stale closure 防止)。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Piano from "./Piano";
import ChordPalette, { type ChordPatternId } from "./ChordPalette";
import ChordTonePiano from "./ChordTonePiano";
import ProgressionList from "./ProgressionList";
import PianoRoll from "./PianoRoll";
import ScalePicker from "./ScalePicker";
import DrumPad, { type DrumPadHandle } from "./DrumPad";
import {
  downloadBlob,
  emptyLayer,
  exportToMidi,
  layerDuration,
  Playback,
  quantizeLayer,
  quantizeUnitSec,
  RecordingSession,
  type Layer,
  type LayerId,
  type NoteEvent,
  type QuantizeGrid,
} from "../audio/recorder";
import {
  chordOn,
  ensureAudio,
  holdOff,
  holdOn,
  noteOn,
  releaseAll,
} from "../audio/pianoEngine";
import {
  bassChordOn,
  bassHoldOff,
  bassHoldOn,
  bassReleaseAll,
  setBassType,
  type BassType,
} from "../audio/bassEngine";
import {
  synthChordOn,
  synthHoldOff,
  synthHoldOn,
  synthReleaseAll,
} from "../audio/synthEngine";
import {
  guitarChordOn,
  guitarHoldOff,
  guitarHoldOn,
  guitarReleaseAll,
  guitarTriggerNote,
  setGuitarType,
  type GuitarType,
} from "../audio/guitarEngine";
import {
  acousticChordOn,
  acousticHoldOff,
  acousticHoldOn,
  acousticReleaseAll,
  acousticTriggerNote,
} from "../audio/acousticGuitarEngine";
import {
  isVocalLoaded,
  preloadVocal,
  setVocalExpression,
  setVocalSyllable,
  setVocalVowel,
  vocalChordOn,
  vocalHoldOff,
  vocalHoldOn,
  vocalReleaseAll,
  type VocalExpression,
  type VocalSyllable,
  type VocalVowel,
} from "../audio/vocalEngine";
import {
  setMetronomeBpm,
  startMetronome,
  stopMetronome,
} from "../audio/metronome";
import { useComputerKeyboard } from "../input/useComputerKeyboard";
import { useWebMIDI } from "../input/useWebMIDI";
import { scaleDisplayName, type Scale } from "../music/scale";
import {
  buildLibraryUrl,
  consumeLoadIntent,
  loadSlot,
  writeCurrent,
  type CurrentSnapshot,
} from "../audio/slots";
import {
  chordLabelJa,
  chordSymbol,
  chordVoicing,
  diatonicTriads,
  type HarmonicChord,
} from "../music/chord";
import {
  composeSong,
  COMPOSER_STYLE_LABEL_JA,
  type ComposerStyle,
} from "../composer/autoComposer";
import { AutoComposeSession } from "../composer/autoComposeSession";

interface StudioProps {
  scale: Scale;
  onScaleChange: (s: Scale) => void;
}

type ArmState = "idle" | "recording";

const PALETTE_CHORD_DURATION_SEC = 1.4;
const HISTORY_LIMIT = 50;

/** コードパッド/進行プリセットを armed 楽器ごとにどのレイヤーへ流すか。 */
type PaletteTarget = "chord" | "bass" | "synth" | "guitar" | "acoustic" | "vocal";
function paletteTargetForArmed(a: LayerId): PaletteTarget {
  if (a === "guitar") return "guitar";
  if (a === "acoustic") return "acoustic";
  if (a === "synth") return "synth";
  if (a === "bass") return "bass";
  if (a === "vocal") return "vocal";
  // melody / chord / drum armed のときは「コード」層に流す。
  return "chord";
}

/**
 * コードパッドの各パターン (アルペジオ / 全弾きリズム等) を、実際に鳴っている
 * リズムそのまま「絶対時刻つき NoteEvent[]」に展開する。
 * - baseSec: 開始時刻 (秒)
 * - bpm: 8 分音符・4 分音符の長さ計算に使う
 * これを PianoRoll に流すと、鳴っている音をそのままピアノロールで見られる。
 */
function buildPatternEvents(
  pattern: ChordPatternId,
  midiNotes: number[],
  baseSec: number,
  bpm: number,
): NoteEvent[] {
  const beatSec = 60 / Math.max(1, bpm);
  const eighthSec = beatSec / 2;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const root = sorted[0] ?? 48;
  const third = sorted[1] ?? root + 4;
  const fifth = sorted[2] ?? root + 7;
  const out: NoteEvent[] = [];
  const pushBlock = (ms: number[], s: number, d: number, v = 0.8) => {
    for (const m of ms) {
      out.push({ midi: m, startSec: s, durationSec: Math.max(0.05, d), velocity: v });
    }
  };
  const push1 = (m: number, s: number, d: number, v = 0.8) => {
    out.push({ midi: m, startSec: s, durationSec: Math.max(0.05, d), velocity: v });
  };
  if (pattern === "guitar8th" || pattern === "acoustic8th") {
    const tones = sorted.length >= 3 ? sorted : [root, third, fifth];
    const up = tones;
    const down = [...tones].reverse().slice(1, tones.length - 1);
    const seq = [...up, ...down, ...up].slice(0, 8);
    seq.forEach((m, i) => push1(m, baseSec + i * eighthSec, eighthSec * 0.9, 0.85));
  } else if (pattern === "guitar8thChord" || pattern === "acoustic8thChord") {
    pushBlock(midiNotes, baseSec, eighthSec, 0.85);
  } else if (pattern === "piano1") {
    // 4 分音符 1 発 (短く弾く)。コードパッド (長押し) との差別化用。
    pushBlock(midiNotes, baseSec, beatSec * 0.9, 0.8);
  } else if (pattern === "piano2") {
    const tones = [root, third, fifth, root + 12];
    [...tones, ...tones].forEach((m, i) =>
      push1(m, baseSec + i * eighthSec, eighthSec * 0.95, 0.8),
    );
  } else if (pattern === "piano3") {
    const tones = [root + 12, fifth, third, root];
    [...tones, ...tones].forEach((m, i) =>
      push1(m, baseSec + i * eighthSec, eighthSec * 0.95, 0.8),
    );
  } else if (pattern === "piano4") {
    const tones = [root, fifth, third, fifth];
    [...tones, ...tones].forEach((m, i) =>
      push1(m, baseSec + i * eighthSec, eighthSec * 0.95, 0.8),
    );
  } else if (pattern === "piano5") {
    push1(root - 12, baseSec, beatSec * 0.95, 0.85);
    const upper = [third, fifth, root + 12];
    for (let i = 1; i < 4; i++) {
      pushBlock(upper, baseSec + i * beatSec, beatSec * 0.9, 0.7);
    }
  } else if (pattern === "piano6") {
    for (let i = 0; i < 8; i++) {
      pushBlock(midiNotes, baseSec + i * eighthSec, eighthSec * 0.9, 0.7);
    }
  } else if (pattern === "piano7") {
    for (let i = 0; i < 4; i++) {
      pushBlock(midiNotes, baseSec + i * beatSec, beatSec * 0.9, 0.75);
    }
  } else if (pattern === "piano8") {
    for (let i = 0; i < 2; i++) {
      pushBlock(midiNotes, baseSec + i * beatSec * 2, beatSec * 2 * 0.95, 0.75);
    }
  } else if (pattern === "piano9") {
    [0, 1.5, 3].forEach((b) =>
      pushBlock(midiNotes, baseSec + b * beatSec, eighthSec * 2, 0.78),
    );
  } else if (pattern === "piano10") {
    // チャールストン: 最終ヒット (3.5 拍) + duration が 4 拍を超えないように、
    // 8 分音符 × 0.9 (= eighthSec * 0.9) に縮める。3.5 + 0.45 = 3.95 < 4 拍。
    [0, 1.5, 2, 3.5].forEach((b) =>
      pushBlock(midiNotes, baseSec + b * beatSec, eighthSec * 0.9, 0.78),
    );
  }
  return out;
}

interface Snapshot {
  melody: Layer;
  chord: Layer;
  drum: Layer;
  bass: Layer;
  synth: Layer;
  guitar: Layer;
  acoustic: Layer;
  vocal: Layer;
}

/** 編集モード時の追加ノート長。"free" は 0.5 秒固定。 */
type NoteLength = "free" | "1/4" | "1/8" | "1/16" | "1/32";

function noteLengthToSec(nl: NoteLength, bpm: number): number {
  if (nl === "free") return 0.5;
  const beat = 60 / Math.max(1, bpm);
  switch (nl) {
    case "1/4":
      return beat;
    case "1/8":
      return beat / 2;
    case "1/16":
      return beat / 4;
    case "1/32":
      return beat / 8;
  }
}

/**
 * 入力パネルのカルーセル。
 * 横スワイプ (touch) または ◀ ▶ ボタンでパネル切替。
 * - CSS scroll-snap で iOS でも自然なスナップ動作
 * - すべてのパネルを常に DOM に保持 (音源・状態を維持)
 */
interface SwipeCarouselProps {
  panels: { id: string; title: string; node: ReactNode }[];
}
function SwipeCarousel({ panels }: SwipeCarouselProps) {
  const [page, setPage] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const w = c.clientWidth;
        if (w > 0) {
          const p = Math.round(c.scrollLeft / w);
          setPage(Math.max(0, Math.min(panels.length - 1, p)));
        }
      });
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      c.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [panels.length]);

  const goTo = useCallback((p: number) => {
    const c = containerRef.current;
    if (!c) return;
    const target = Math.max(0, Math.min(panels.length - 1, p));
    c.scrollTo({ left: c.clientWidth * target, behavior: "smooth" });
  }, [panels.length]);

  return (
    <div className="flex flex-col gap-2">
      {/* タブ + 左右ボタン */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={page === 0}
          className="rounded-full border border-ink-300 bg-white px-2.5 py-1 text-sm text-ink-700 shadow-sm hover:border-accent-300 disabled:opacity-30"
          aria-label="前のパネル"
        >
          ◀
        </button>
        <div className="flex flex-1 flex-wrap items-center justify-center gap-1.5">
          {panels.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => goTo(i)}
              className={[
                "rounded-full px-3 py-1 text-xs font-semibold transition",
                i === page
                  ? "bg-accent-500 text-white shadow-sm"
                  : "border border-ink-300 bg-white text-ink-700 hover:border-accent-300",
              ].join(" ")}
            >
              {p.title}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={page >= panels.length - 1}
          className="rounded-full border border-ink-300 bg-white px-2.5 py-1 text-sm text-ink-700 shadow-sm hover:border-accent-300 disabled:opacity-30"
          aria-label="次のパネル"
        >
          ▶
        </button>
      </div>

      {/* スクロールコンテナ (横スワイプ + scroll-snap) */}
      <div
        ref={containerRef}
        className="flex w-full snap-x snap-mandatory overflow-x-auto scroll-smooth"
        style={{
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
      >
        {panels.map((p) => (
          <div
            key={p.id}
            className="w-full shrink-0 snap-start snap-always pr-0"
            style={{ flex: "0 0 100%" }}
          >
            {p.node}
          </div>
        ))}
      </div>

      <div className="text-center text-[11px] text-ink-500">
        ← スワイプで「{panels.map((p) => p.title).join(" → ")}」を切替 →
      </div>
    </div>
  );
}

export default function Studio({ scale, onScaleChange }: StudioProps) {
  const [melody, setMelody] = useState<Layer>(() => emptyLayer("melody", "メロディ"));
  const [chord, setChord] = useState<Layer>(() => emptyLayer("chord", "コード"));
  const [drum, setDrum] = useState<Layer>(() => emptyLayer("drum", "ドラム"));
  const [bass, setBass] = useState<Layer>(() => emptyLayer("bass", "ベース"));
  const [synth, setSynth] = useState<Layer>(() => emptyLayer("synth", "シンセ"));
  const [guitar, setGuitar] = useState<Layer>(() => emptyLayer("guitar", "ギター"));
  const [acoustic, setAcoustic] = useState<Layer>(() => emptyLayer("acoustic", "アコギ"));
  const [vocal, setVocal] = useState<Layer>(() => emptyLayer("vocal", "ボーカル"));
  const [armed, setArmed] = useState<LayerId>("melody");
  /**
   * 主アーム楽器とは別に、ドラム層も並行録音するか。
   * `armed === "drum"` のときは無視 (ドラム自身が主録音対象)。
   */
  const [drumAlsoArmed, setDrumAlsoArmed] = useState<boolean>(false);
  /**
   * 録音時の自動補正モード。
   * - "auto": 録音中のドラムヒットを拍にスナップし、停止時に layer 全体をクオンタイズする (現状の挙動)。
   * - "raw":  手弾きのタイミングそのままで記録する (補正なし)。
   */
  const [recordCorrectionMode, setRecordCorrectionMode] = useState<"auto" | "raw">("auto");
  /** ベースのタイプ: ウッド / シンセ / スラップ。 */
  const [bassType, setBassTypeState] = useState<BassType>("wood");
  /** ギターのタイプ: クリーン / ディストーション。 */
  const [guitarType, setGuitarTypeState] = useState<GuitarType>("distortion");
  const [state, setState] = useState<ArmState>("idle");
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());
  const [playbackHighlight, setPlaybackHighlight] = useState<Set<number>>(new Set());
  const [activeChordIndex, setActiveChordIndex] = useState<number | null>(null);
  const [spotlightLabel, setSpotlightLabel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Cubase 風シーク位置 (秒)。停止中の再生ヘッド位置を保持。
   *  再生開始時はここから始まる。 */
  const [seekedSec, setSeekedSec] = useState(0);
  const [chordRecCount, setChordRecCount] = useState(0);
  const [drumRecCount, setDrumRecCount] = useState(0);
  const [selectedChord, setSelectedChord] = useState<HarmonicChord | null>(null);
  const [bpm, setBpm] = useState<number>(100);
  const [quantizeGrid, setQuantizeGrid] = useState<QuantizeGrid>("1/16");
  const [editMode, setEditMode] = useState(false);
  const [eraserMode, setEraserMode] = useState(false);
  const [noteLength, setNoteLength] = useState<NoteLength>("1/8");
  const [metronomeOn, setMetronomeOn] = useState(true);
  const [vocalVowel, setVocalVowelState] = useState<VocalVowel>("aah");
  const [vocalSyllable, setVocalSyllableState] = useState<VocalSyllable>("none");
  const [vocalExpression, setVocalExpressionState] = useState<VocalExpression>("natural");
  const [vocalSampleReady, setVocalSampleReady] = useState<boolean>(() => isVocalLoaded());
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  // 自動作曲モード関連 state
  const [autoComposeStyle, setAutoComposeStyle] = useState<ComposerStyle>("pop");
  const [autoComposeBars, setAutoComposeBars] = useState<number>(16);
  const [autoComposeSpeed, setAutoComposeSpeed] = useState<number>(1);
  const [autoComposing, setAutoComposing] = useState<boolean>(false);
  const [autoComposeProgress, setAutoComposeProgress] = useState<{
    pct: number;
    bar: number;
    totalBars: number;
  } | null>(null);
  const audioReady = useRef(false);

  const sessionRef = useRef<RecordingSession | null>(null);
  /**
   * ドラム同時録音用の並列セッション。
   * armed !== "drum" でも drumAlsoArmed=true のとき、メイン session と並行して
   * ドラム層に hit を書き込むために使う。
   */
  const drumSessionRef = useRef<RecordingSession | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const overdubRef = useRef<Playback | null>(null);
  const tickRef = useRef<number | null>(null);
  const progressionTimersRef = useRef<number[]>([]);
  const drumPadRef = useRef<DrumPadHandle | null>(null);
  const autoComposeRef = useRef<AutoComposeSession | null>(null);

  // ---- stale closure 対策: 常に最新の state/armed を参照する ref ---------
  const stateRef = useRef<ArmState>("idle");
  const armedRef = useRef<LayerId>("melody");
  const drumAlsoArmedRef = useRef<boolean>(false);
  const recordCorrectionModeRef = useRef<"auto" | "raw">("auto");
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);
  // ボーカルがアームされた / 母音が切り替わった瞬間にサンプルロードを開始 (2.8MB/母音)。
  // ロード完了までは UI に「読み込み中」を表示するため、200ms 間隔で監視する。
  useEffect(() => {
    if (armed !== "vocal") return;
    setVocalVowel(vocalVowel);
    preloadVocal(vocalVowel);
    setVocalSampleReady(isVocalLoaded(vocalVowel));
    if (isVocalLoaded(vocalVowel)) return;
    const id = window.setInterval(() => {
      if (isVocalLoaded(vocalVowel)) {
        setVocalSampleReady(true);
        window.clearInterval(id);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [armed, vocalVowel]);
  // 子音アタック / 表現プリセットの同期。
  useEffect(() => {
    setVocalSyllable(vocalSyllable);
  }, [vocalSyllable]);
  useEffect(() => {
    setVocalExpression(vocalExpression);
  }, [vocalExpression]);
  useEffect(() => {
    drumAlsoArmedRef.current = drumAlsoArmed;
  }, [drumAlsoArmed]);
  useEffect(() => {
    recordCorrectionModeRef.current = recordCorrectionMode;
  }, [recordCorrectionMode]);
  // ベースタイプ切替はエンジン側のチェーンを再構築する。
  useEffect(() => {
    setBassType(bassType);
  }, [bassType]);
  // ギタータイプ切替もエンジン側のチェーンを再構築する。
  useEffect(() => {
    setGuitarType(guitarType);
  }, [guitarType]);

  // スケール変更時はコード選択をリセット
  useEffect(() => {
    setSelectedChord(null);
    setActiveChordIndex(null);
    setSpotlightLabel(null);
  }, [scale.rootPitchClass, scale.kind]);

  // ---- Library タブとの同期 -------------------------------------------------
  // Studio の現在状態を localStorage に写し続け、別タブの保存ライブラリから
  // 保存ボタンを押せるようにする。Studio の操作中に書き込みが多発しないよう
  // 軽く debounce する。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      const snap: CurrentSnapshot = {
        bpm,
        scaleRoot: scale.rootPitchClass,
        scaleKind: scale.kind,
        updatedAt: Date.now(),
        melody,
        chord,
        drum,
        bass,
        synth,
        guitar,
        acoustic,
        vocal,
      };
      writeCurrent(snap);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [bpm, scale.rootPitchClass, scale.kind, melody, chord, drum, bass, synth, guitar, acoustic, vocal]);

  // Library タブから「このスロットをロードして」と依頼されたら受け取る。
  // - マウント時に既存の loadIntent を消費 (Library で先にボタンを押されたケース)
  // - 以降は storage イベントで他タブからの書き込みを検知。
  const loadSlotRef = useRef<((slot: number) => void) | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const initial = consumeLoadIntent();
    if (initial != null) loadSlotRef.current?.(initial);
    function onStorage(e: StorageEvent) {
      if (e.key !== "melodycatch.loadIntent") return;
      const slot = consumeLoadIntent();
      if (slot != null) loadSlotRef.current?.(slot);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ---- 録音中レイヤを React に通知 (PianoRoll 即時更新用) ------------------
  // sessionRef から `snapshotNotes()` で確定 + 押しっぱなし両方のスナップショットを取り、
  // React state に反映する。これにより:
  //   - 録音中の押下中ノートも (現在時刻まで伸びた仮の長さで) リアルタイム表示される
  //   - 確定済みの全ノートが毎フレーム新しい配列として state に流れるので
  //     レコーダ側の追記とぶつからずに最新が見える
  const refreshScheduledRef = useRef(false);
  const scheduleRefresh = useCallback(() => {
    if (refreshScheduledRef.current) return;
    refreshScheduledRef.current = true;
    requestAnimationFrame(() => {
      refreshScheduledRef.current = false;
      const sess = sessionRef.current;
      if (!sess) return;
      const notes = sess.snapshotNotes();
      if (armedRef.current === "melody") {
        setMelody((cur) => ({ ...cur, notes }));
      } else if (armedRef.current === "chord") {
        setChord((cur) => ({ ...cur, notes }));
      } else if (armedRef.current === "bass") {
        setBass((cur) => ({ ...cur, notes }));
      } else if (armedRef.current === "synth") {
        setSynth((cur) => ({ ...cur, notes }));
      } else if (armedRef.current === "guitar") {
        setGuitar((cur) => ({ ...cur, notes }));
      } else if (armedRef.current === "acoustic") {
        setAcoustic((cur) => ({ ...cur, notes }));
      } else if (armedRef.current === "vocal") {
        setVocal((cur) => ({ ...cur, notes }));
      } else {
        setDrum((cur) => ({ ...cur, notes }));
      }
    });
  }, []);

  // 録音中は毎フレーム scheduleRefresh を呼んで、押しっぱなしのノートが
  // 「だんだん伸びていく」アニメーションを PianoRoll に反映する。
  useEffect(() => {
    if (state !== "recording") return;
    let raf = 0;
    const tick = () => {
      scheduleRefresh();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, scheduleRefresh]);

  // ---- Undo/Redo: 破壊的操作の前にスナップショット保存 -----------------------
  const pushHistory = useCallback(() => {
    setPast((p) => {
      const snap: Snapshot = { melody, chord, drum, bass, synth, guitar, acoustic, vocal };
      const next = [...p, snap];
      if (next.length > HISTORY_LIMIT) next.shift();
      return next;
    });
    setFuture([]);
  }, [melody, chord, drum, bass, synth, guitar, acoustic, vocal]);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [...f, { melody, chord, drum, bass, synth, guitar, acoustic, vocal }]);
      setMelody(prev.melody);
      setChord(prev.chord);
      setDrum(prev.drum);
      setBass(prev.bass);
      setSynth(prev.synth);
      setGuitar(prev.guitar);
      setAcoustic(prev.acoustic);
      setVocal(prev.vocal);
      return p.slice(0, -1);
    });
  }, [melody, chord, drum, bass, synth, guitar, acoustic, vocal]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1];
      setPast((p) => [...p, { melody, chord, drum, bass, synth, guitar, acoustic, vocal }]);
      setMelody(next.melody);
      setChord(next.chord);
      setDrum(next.drum);
      setBass(next.bass);
      setSynth(next.synth);
      setGuitar(next.guitar);
      setAcoustic(next.acoustic);
      setVocal(next.vocal);
      return f.slice(0, -1);
    });
  }, [melody, chord, drum, bass, synth, guitar, acoustic, vocal]);

  // Cmd+Z / Ctrl+Z = undo, Cmd+Shift+Z / Ctrl+Y = redo
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ---- ドラムヒット (DrumPad ループから来る) -------------------------------
  // 録音時はピアノロール上の拍グリッドに必ず重なるよう自動スナップする。
  // クオンタイズ設定が "off" のときは 1/16 をデフォルトのドラムグリッドとして使う。
  const handleDrumHit = useCallback(
    (midi: number, velocity: number) => {
      if (stateRef.current !== "recording") return;
      // 書き込み先セッションを決定:
      //   ・armed === "drum" の場合はメイン sessionRef
      //   ・それ以外で drumAlsoArmed === true の場合は drumSessionRef (並列録音)
      let targetSession: RecordingSession | null = null;
      if (armedRef.current === "drum") {
        targetSession = sessionRef.current;
      } else if (drumAlsoArmedRef.current) {
        targetSession = drumSessionRef.current;
      }
      if (!targetSession) return;
      // raw モード時はスナップを掛けず、叩いたタイミングそのままで記録する。
      let snap = 0;
      if (recordCorrectionModeRef.current === "auto") {
        const beat = 60 / Math.max(1, bpm);
        snap =
          quantizeGrid !== "off"
            ? quantizeUnitSec(quantizeGrid, bpm)
            : beat / 4; // 1/16 fallback
      }
      // ドラムは percussive: 短い固定 duration で 1 ヒットを記録 (auto モードなら拍にスナップ)。
      targetSession.recordChord([midi], 0.05, velocity, snap || undefined);
      setDrumRecCount((n) => n + 1);
      scheduleRefresh();
    },
    [scheduleRefresh, bpm, quantizeGrid],
  );

  // ---- audio gate -----------------------------------------------------------
  const arm = useCallback(async () => {
    if (audioReady.current) return;
    await ensureAudio();
    audioReady.current = true;
  }, []);

  // ---- 共通 note handler (ピアノ/キーボード/MIDI) ---------------------------
  // bass / synth は専用エンジン、それ以外 (melody/chord/drum) は pianoEngine に流す
  const handleNoteOn = useCallback(
    async (midi: number, velocity = 0.85) => {
      await arm();
      if (armedRef.current === "bass") {
        bassHoldOn(midi, velocity);
      } else if (armedRef.current === "synth") {
        synthHoldOn(midi, velocity);
      } else if (armedRef.current === "guitar") {
        guitarHoldOn(midi, velocity);
      } else if (armedRef.current === "acoustic") {
        acousticHoldOn(midi, velocity);
      } else if (armedRef.current === "vocal") {
        vocalHoldOn(midi, velocity);
      } else {
        holdOn(midi, velocity);
      }
      setActiveNotes((cur) => {
        const next = new Set(cur);
        next.add(midi);
        return next;
      });
      if (stateRef.current === "recording" && sessionRef.current) {
        sessionRef.current.noteOn(midi, velocity);
        scheduleRefresh();
      }
    },
    [arm, scheduleRefresh],
  );

  const handleNoteOff = useCallback(
    (midi: number) => {
      // 入力中に armed が切り替わっている可能性に備えて全エンジンを off する
      holdOff(midi);
      bassHoldOff(midi);
      synthHoldOff(midi);
      guitarHoldOff(midi);
      acousticHoldOff(midi);
      vocalHoldOff(midi);
      setActiveNotes((cur) => {
        if (!cur.has(midi)) return cur;
        const next = new Set(cur);
        next.delete(midi);
        return next;
      });
      if (stateRef.current === "recording" && sessionRef.current) {
        sessionRef.current.noteOff(midi);
        scheduleRefresh();
      }
    },
    [scheduleRefresh],
  );

  // ---- PC キーボード / MIDI -------------------------------------------------
  useComputerKeyboard({
    enabled: !playing,
    onNoteOn: (m) => void handleNoteOn(m),
    onNoteOff: handleNoteOff,
  });

  const midi = useWebMIDI({
    onNoteOn: (m, v) => void handleNoteOn(m, v),
    onNoteOff: handleNoteOff,
  });

  // ---- ライブ用 (非録音/非再生中) のピアノロール書き込みヘッド ---------------
  // 録音も再生もしていないときに「コードパッドの連打」を t=0 に重ねないよう、
  // ここに「次に書く位置」を保持し、イベントを書くたびに自動で進める。
  // 録音/再生が始まったら無視され、開始時にリセットする。
  const livePlayheadSecRef = useRef(0);

  // ---- PianoRoll の再生ヘッド用 getter -------------------------------------
  // 録音中はセッションの elapsed、再生中は Playback の elapsed。
  // それ以外は livePlayheadSec (ライブ書き込み用カーソル) を、ユーザーが
  // ルーラを直接クリックしたときは seekedSec を返す。
  const getPlayheadSec = useCallback(() => {
    if (sessionRef.current && stateRef.current === "recording") {
      return sessionRef.current.elapsedSec();
    }
    if (playbackRef.current && playing) {
      return playbackRef.current.elapsedSec();
    }
    return Math.max(seekedSec, livePlayheadSecRef.current);
  }, [playing, seekedSec]);

  // 再生/録音が止まったら、ライブ書き込みヘッドを seekedSec に戻す。
  useEffect(() => {
    if (!playing && state !== "recording") {
      livePlayheadSecRef.current = seekedSec;
    }
  }, [playing, state, seekedSec]);

  /** BPM の拍境界に最も近い位置に丸める (前方丸め: 次の拍頭)。 */
  function snapToNextBeat(sec: number, bpmVal: number): number {
    const beat = 60 / Math.max(1, bpmVal);
    return Math.ceil((sec - 1e-6) / beat) * beat;
  }

  // ---- 鳴っているコード/パターンを target レイヤーへ流し込む -----------------
  // 「コードパッドや進行プリセットで鳴っている音を、リアルタイムにピアノロールへ
  //  反映する」ためのユーティリティ。
  // 録音中で armed===target のときはレコーダーセッションの layer.notes に直接 push
  // して scheduleRefresh、それ以外のときは React state を直接 append する。
  // 非録音/非再生時はライブ書き込みヘッドを events の終端まで進める。
  const reflectEventsToTarget = useCallback(
    (events: NoteEvent[], target: PaletteTarget) => {
      if (events.length === 0) return;
      // 録音中で、armed 楽器がそのレイヤーに対応している時だけ実際に書き込む。
      // 録音外では「鳴らすだけ」で PianoRoll には反映しない (= 勝手に保存されない)。
      if (
        stateRef.current === "recording" &&
        armedRef.current === target &&
        sessionRef.current
      ) {
        sessionRef.current.addEvents(events);
        scheduleRefresh();
      }
    },
    [scheduleRefresh],
  );

  // ---- コードパレット --------------------------------------------------------
  // armed されている楽器に合わせてコードを発音する。
  // - chord/melody/drum: ピアノ
  // - bass: ベース (ルートを 1oct 下げて重ねる)
  // - synth: シンセ
  // - guitar: ギター (ストロークっぽくずらして発音)
  // 鳴った音は録音中・録音外問わず、armed 楽器に対応する target レイヤーへ反映する。
  const onPaletteChord = useCallback(
    async (c: HarmonicChord, midiNotes: number[]) => {
      await arm();
      const a = armedRef.current;
      if (a === "bass") bassChordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
      else if (a === "synth") synthChordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
      else if (a === "guitar") guitarChordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
      else if (a === "acoustic") acousticChordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
      else if (a === "vocal") vocalChordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
      else chordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);

      const triads = diatonicTriads(scale);
      const idx = triads.findIndex(
        (t) =>
          t.rootPitchClass === c.rootPitchClass && t.quality === c.quality,
      );
      setActiveChordIndex(idx >= 0 ? idx : null);
      setSpotlightLabel(`${chordSymbol(c)}  ${chordLabelJa(c)}`);
      setPlaybackHighlight(new Set(midiNotes));
      setSelectedChord(c);
      window.setTimeout(() => {
        setPlaybackHighlight(new Set());
        setActiveChordIndex(null);
      }, PALETTE_CHORD_DURATION_SEC * 1000);

      // 鳴った音をピアノロールに反映 (録音中・録音外問わず target レイヤーへ追加)。
      const target = paletteTargetForArmed(armedRef.current);
      // 非録音/非再生中は拍境界に揃えて、見た目もリズムも綺麗に並ぶようにする。
      const rawBase = getPlayheadSec();
      const base =
        stateRef.current === "recording" || playing
          ? rawBase
          : snapToNextBeat(rawBase, bpm);
      const events: NoteEvent[] = midiNotes.map((m) => ({
        midi: m,
        startSec: base,
        durationSec: PALETTE_CHORD_DURATION_SEC,
        velocity: 0.8,
      }));
      reflectEventsToTarget(events, target);
      if (stateRef.current === "recording" && armedRef.current === target) {
        setChordRecCount((n) => n + 1);
      }
    },
    [arm, scale, bpm, playing, getPlayheadSec, reflectEventsToTarget],
  );

  // ---- コードパレット: 楽器別サブパターン -----------------------------------
  // ChordPalette の各コードボタンの真下に出る補助ボタンから呼ばれる。
  // 【ギター armed】
  //   - guitar8th:      8 分音符アルペジオ (コードトーンを 1-2-3-4-5-4-3-2 風に)
  //   - guitar8thChord: コード全弾き 1 回 (8 分音符長・全弦完全同時。ストロークのずらしなし)
  // 【ピアノ (コード層) armed】
  //   アルペジオ系:
  //     - piano1:  ブロック (全音同時 × 1 回)
  //     - piano2:  上行アルペジオ (root→3rd→5th→oct)
  //     - piano3:  下行アルペジオ
  //     - piano4:  アルベルティ (root-5th-3rd-5th)
  //     - piano5:  ベース+和音
  //   コード全弾きリズム系 (全音同時に rhythmic pattern で叩く):
  //     - piano6:  8 ビート連打 (8 分音符 × 8)
  //     - piano7:  4 ビート連打 (4 分音符 × 4)
  //     - piano8:  ハーフ (2 分音符 × 2)
  //     - piano9:  シンコペ (1 / &2 / 4 の 3 ヒット)
  //     - piano10: チャールストン (1 / &2 / 3 / &4 の 4 ヒット)
  // 録音中は onPaletteChord と同じく、現在の armed 楽器が
  // chord / guitar / synth のいずれかなら、コードイベントとして 1 個記録する
  // (個々のヒットではなく「コードを 1 回鳴らした」という単位で残す)。
  const onPaletteChordPattern = useCallback(
    async (
      chord: HarmonicChord,
      midiNotes: number[],
      pattern: ChordPatternId,
    ) => {
      await arm();
      const beatSec = 60 / Math.max(1, bpm);
      const eighthSec = beatSec / 2; // 8 分音符の長さ (秒)

      // コードトーンを昇順にソート (パターン処理しやすくするため)。
      const sorted = [...midiNotes].sort((a, b) => a - b);
      const root = sorted[0] ?? 48;
      const third = sorted[1] ?? root + 4;
      const fifth = sorted[2] ?? root + 7;

      if (pattern === "guitar8th") {
        // 8 分音符 × 8 ヒット、1 小節分。最低 3 音が必要なのでパディング。
        const tones = sorted.length >= 3 ? sorted : [root, third, fifth];
        // 上行 (root → high) → 下行 (high → root) を組み合わせて 8 ヒットに。
        const up = tones;
        const down = [...tones].reverse().slice(1, tones.length - 1);
        const seq = [...up, ...down, ...up].slice(0, 8);
        seq.forEach((m, i) => {
          window.setTimeout(
            () => guitarTriggerNote(m, eighthSec * 0.9, 0.85),
            i * eighthSec * 1000,
          );
        });
      } else if (pattern === "guitar8thChord") {
        // 8 分音符長で「コードを一回だけ」鳴らす。
        // guitarChordOn だと弦ごとに 14ms ずつずれるため弱いアルペジオに聴こえる。
        // ユーザー要望: ジャラ感ゼロで完全に同時に鳴らす → guitarTriggerNote を直接並列発音。
        for (const m of midiNotes) {
          guitarTriggerNote(m, eighthSec * 0.9, 0.85);
        }
      } else if (pattern === "acoustic8th") {
        // アコギ版 8 分音符アルペジオ (ギターと同じパターンを acousticTriggerNote で)。
        const tones = sorted.length >= 3 ? sorted : [root, third, fifth];
        const up = tones;
        const down = [...tones].reverse().slice(1, tones.length - 1);
        const seq = [...up, ...down, ...up].slice(0, 8);
        seq.forEach((m, i) => {
          window.setTimeout(
            () => acousticTriggerNote(m, eighthSec * 0.9, 0.85),
            i * eighthSec * 1000,
          );
        });
      } else if (pattern === "acoustic8thChord") {
        // アコギ版 8 分音符長コード一発 (ジャラ感ゼロで同時発音)。
        for (const m of midiNotes) {
          acousticTriggerNote(m, eighthSec * 0.9, 0.85);
        }
      } else if (pattern === "piano1") {
        // 4 分音符 1 発: 短いブロックコードを 1 回だけ。コードパッドとの差別化用。
        chordOn(midiNotes, 0.8, beatSec * 0.9);
      } else if (pattern === "piano2") {
        // 上行アルペジオ (root → 3rd → 5th → octave-root → ...) 8 ヒット。
        const tones = [root, third, fifth, root + 12];
        const seq = [...tones, ...tones];
        seq.forEach((m, i) => {
          window.setTimeout(
            () => noteOn(m, 0.8, eighthSec * 0.95),
            i * eighthSec * 1000,
          );
        });
      } else if (pattern === "piano3") {
        // 下行アルペジオ。
        const tones = [root + 12, fifth, third, root];
        const seq = [...tones, ...tones];
        seq.forEach((m, i) => {
          window.setTimeout(
            () => noteOn(m, 0.8, eighthSec * 0.95),
            i * eighthSec * 1000,
          );
        });
      } else if (pattern === "piano4") {
        // アルベルティ・バス: root - 5th - 3rd - 5th を 2 回繰り返し。
        const tones = [root, fifth, third, fifth];
        const seq = [...tones, ...tones];
        seq.forEach((m, i) => {
          window.setTimeout(
            () => noteOn(m, 0.8, eighthSec * 0.95),
            i * eighthSec * 1000,
          );
        });
      } else if (pattern === "piano5") {
        // ベース+和音: 1 拍目に低音 root、2-4 拍目で上声 (3rd+5th+octave) を鳴らす
        // ピアノ伴奏で頻出の「ボン・ジャッ・ジャッ・ジャッ」パターン。
        const bass = root - 12;
        const upper = [third, fifth, root + 12];
        // 1拍目: 低音
        noteOn(bass, 0.85, beatSec * 0.95);
        // 2-4拍目: 上声 (1 拍ごと)
        for (let i = 1; i < 4; i++) {
          window.setTimeout(
            () => chordOn(upper, 0.7, beatSec * 0.9),
            i * beatSec * 1000,
          );
        }
      } else if (pattern === "piano6") {
        // 8 ビート連打 (コード全弾き × 8): 1 小節を 8 分音符 × 8 でジャカ打ち。
        for (let i = 0; i < 8; i++) {
          window.setTimeout(
            () => chordOn(midiNotes, 0.7, eighthSec * 0.9),
            i * eighthSec * 1000,
          );
        }
      } else if (pattern === "piano7") {
        // 4 ビート連打 (コード全弾き × 4): 1 小節を 4 分音符 × 4 で。
        for (let i = 0; i < 4; i++) {
          window.setTimeout(
            () => chordOn(midiNotes, 0.75, beatSec * 0.9),
            i * beatSec * 1000,
          );
        }
      } else if (pattern === "piano8") {
        // ハーフ (2 分音符 × 2): 1 拍目と 3 拍目にコード全弾き、それぞれ 2 拍分ずつ伸ばす。
        for (let i = 0; i < 2; i++) {
          window.setTimeout(
            () => chordOn(midiNotes, 0.75, beatSec * 2 * 0.95),
            i * beatSec * 2 * 1000,
          );
        }
      } else if (pattern === "piano9") {
        // シンコペ: 1 拍目 / 2 拍目の裏 / 4 拍目の 3 ヒット。
        // ポップス/ロック伴奏でよく出る「タン・タ・タン」のリズム。
        const hits = [0, 1.5, 3]; // 拍 (0-indexed: 1 拍目=0, 2&=1.5, 4 拍目=3)
        hits.forEach((b) => {
          window.setTimeout(
            () => chordOn(midiNotes, 0.78, eighthSec * 2),
            b * beatSec * 1000,
          );
        });
      } else if (pattern === "piano10") {
        // チャールストン: 1 拍目 / 2 拍目の裏 / 3 拍目 / 4 拍目の裏 の 4 ヒット。
        // 最終ヒットが 4 拍を超えないように duration を 8 分音符 × 0.9 に縮める。
        const hits = [0, 1.5, 2, 3.5];
        hits.forEach((b) => {
          window.setTimeout(
            () => chordOn(midiNotes, 0.78, eighthSec * 0.9),
            b * beatSec * 1000,
          );
        });
      }

      // ハイライト更新 (onPaletteChord と同じロジック)。
      const triads = diatonicTriads(scale);
      const idx = triads.findIndex(
        (t) =>
          t.rootPitchClass === chord.rootPitchClass &&
          t.quality === chord.quality,
      );
      setActiveChordIndex(idx >= 0 ? idx : null);
      setSpotlightLabel(`${chordSymbol(chord)}  ${chordLabelJa(chord)}`);
      setPlaybackHighlight(new Set(midiNotes));
      setSelectedChord(chord);
      window.setTimeout(() => {
        setPlaybackHighlight(new Set());
        setActiveChordIndex(null);
      }, PALETTE_CHORD_DURATION_SEC * 1000);

      // 鳴ったパターンの各ヒットをそのまま PianoRoll に反映 (録音中/録音外問わず)。
      // 非録音/非再生中は次の拍頭に揃えて、パターンが BPM のグリッドに沿うように。
      const target = paletteTargetForArmed(armedRef.current);
      const rawBase = getPlayheadSec();
      const base =
        stateRef.current === "recording" || playing
          ? rawBase
          : snapToNextBeat(rawBase, bpm);
      const events = buildPatternEvents(pattern, midiNotes, base, bpm);
      reflectEventsToTarget(events, target);
      if (stateRef.current === "recording" && armedRef.current === target) {
        setChordRecCount((n) => n + 1);
      }
    },
    [arm, scale, bpm, playing, getPlayheadSec, reflectEventsToTarget],
  );

  // ---- Z〜M でコードパレットの I〜vii° を発音 -----------------------------
  // QWERTY 下段の Z X C V B N M を 7 つのダイアトニックコードにマッピング。
  // 修飾キー (Cmd/Ctrl/Alt) が押されているときは無視する (undo 等と衝突しないように)。
  // フォーム要素 (input/textarea/select/contentEditable) にフォーカスがあるときも無視。
  useEffect(() => {
    const KEY_TO_INDEX: Record<string, number> = {
      z: 0,
      x: 1,
      c: 2,
      v: 3,
      b: 4,
      n: 5,
      m: 6,
    };
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return; // 押しっぱなしで連打しない
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      const idx = KEY_TO_INDEX[e.key.toLowerCase()];
      if (idx === undefined) return;
      const triads = diatonicTriads(scale);
      const chord = triads[idx];
      if (!chord) return;
      e.preventDefault();
      onPaletteChord(chord, chordVoicing(chord, 48));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scale, onPaletteChord]);

  // 最後にピアノロールを触っていたらスペースキーで再生 / 停止トグル。
  // 毎レンダリングで latest な startPlayback / stopPlayback / playing を ref に格納し、
  // event listener は一度だけ取り付ける。
  const spaceToggleRef = useRef<() => void>(() => {});
  spaceToggleRef.current = () => {
    if (playing) {
      stopPlayback();
    } else {
      void startPlayback();
    }
  };
  useEffect(() => {
    // ピアノロール領域にポインタで触れていたかを追跡。
    const focused = { value: false };
    function onPointerDown(e: PointerEvent) {
      const t = e.target;
      if (t instanceof Element) {
        focused.value = !!t.closest("[data-pianoroll-area]");
      } else {
        focused.value = false;
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== " " && e.code !== "Space") return;
      if (!focused.value) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
        // ボタンにフォーカスが乗っている時はそちらの挙動を優先 (Space で押下)。
        if (tag === "BUTTON") return;
      }
      e.preventDefault();
      spaceToggleRef.current();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // ---- 進行プリセット --------------------------------------------------------
  const onProgressionChord = useCallback(
    async (
      c: HarmonicChord,
      midiNotes: number[],
      delayMs: number,
      durationSec: number,
    ) => {
      await arm();
      const t = window.setTimeout(() => {
        const a = armedRef.current;
        if (a === "bass") bassChordOn(midiNotes, 0.8, durationSec);
        else if (a === "synth") synthChordOn(midiNotes, 0.8, durationSec);
        else if (a === "guitar") guitarChordOn(midiNotes, 0.8, durationSec);
        else if (a === "acoustic") acousticChordOn(midiNotes, 0.8, durationSec);
        else if (a === "vocal") vocalChordOn(midiNotes, 0.8, durationSec);
        else chordOn(midiNotes, 0.8, durationSec);

        setSpotlightLabel(`${chordSymbol(c)}  ${chordLabelJa(c)}`);
        const triads = diatonicTriads(scale);
        const idx = triads.findIndex(
          (x) =>
            x.rootPitchClass === c.rootPitchClass && x.quality === c.quality,
        );
        setActiveChordIndex(idx >= 0 ? idx : null);
        setPlaybackHighlight(new Set(midiNotes));
        setSelectedChord(c);
        // 進行プリセットでも、鳴った瞬間の音をそのまま PianoRoll に反映する。
        const target = paletteTargetForArmed(armedRef.current);
        const rawBase = getPlayheadSec();
        const base =
          stateRef.current === "recording" || playing
            ? rawBase
            : snapToNextBeat(rawBase, bpm);
        const events: NoteEvent[] = midiNotes.map((m) => ({
          midi: m,
          startSec: base,
          durationSec,
          velocity: 0.8,
        }));
        reflectEventsToTarget(events, target);
        if (stateRef.current === "recording" && armedRef.current === target) {
          setChordRecCount((n) => n + 1);
        }
      }, delayMs);
      progressionTimersRef.current.push(t);
    },
    [arm, scale, bpm, playing, getPlayheadSec, reflectEventsToTarget],
  );

  const onProgressionEnd = useCallback(() => {
    setActiveChordIndex(null);
    setSpotlightLabel(null);
    setPlaybackHighlight(new Set());
  }, []);

  // ---- 経過時間タイマ -------------------------------------------------------
  useEffect(() => {
    if (state !== "recording" && !playing) {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      setElapsed(0);
      return;
    }
    tickRef.current = window.setInterval(() => {
      if (state === "recording" && sessionRef.current) {
        setElapsed(sessionRef.current.elapsedSec());
      } else if (playing && playbackRef.current) {
        setElapsed(playbackRef.current.elapsedSec());
      }
    }, 100);
    return () => {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [state, playing]);

  // ---- 録音操作 -------------------------------------------------------------
  async function startRecord() {
    await arm();
    stopPlayback();
    cancelProgressionTimers();

    // 録音は対象レイヤに追記するので Undo 用にスナップショット
    pushHistory();

    // 【オーバーダブ録音】
    // 既存ノートを保持したまま、追加で録音する。
    // 録音「やり直し」では前のテイクが消えないようにするため、
    // emptyLayer に置き換えずに既存 Layer の参照をそのまま使う。
    // 全消しは「譜面を削除」「消しゴム」を使う。
    const layer =
      armed === "melody"
        ? melody
        : armed === "chord"
          ? chord
          : armed === "bass"
            ? bass
            : armed === "synth"
              ? synth
              : armed === "guitar"
                ? guitar
                : armed === "acoustic"
                  ? acoustic
                  : armed === "vocal"
                    ? vocal
                    : drum;

    sessionRef.current = new RecordingSession(layer, {
      preserveExistingNotes: true,
    });
    sessionRef.current.begin();

    // 【ドラム同時録音】armed !== "drum" でも drumAlsoArmed が ON の場合は、
    // ドラム層への並列録音セッションを作る。
    const recordingDrumInParallel = armed !== "drum" && drumAlsoArmed;
    if (recordingDrumInParallel) {
      drumSessionRef.current = new RecordingSession(drum, {
        preserveExistingNotes: true,
      });
      drumSessionRef.current.begin();
    } else {
      drumSessionRef.current = null;
    }

    setChordRecCount(0);
    setDrumRecCount(0);

    // DAW 風オーバーダブ: 録音対象以外の既存レイヤを同時再生
    // ドラム同時録音中は、ドラム層もオーバーダブ対象から外す (録音先として書き込み中なので)。
    const drumIsRecordTarget = armed === "drum" || recordingDrumInParallel;
    const otherLayers: Layer[] = [];
    if (armed !== "melody" && melody.notes.length > 0) otherLayers.push(melody);
    if (armed !== "chord" && chord.notes.length > 0) otherLayers.push(chord);
    if (armed !== "bass" && bass.notes.length > 0) otherLayers.push(bass);
    if (armed !== "synth" && synth.notes.length > 0) otherLayers.push(synth);
    if (armed !== "guitar" && guitar.notes.length > 0) otherLayers.push(guitar);
    if (armed !== "acoustic" && acoustic.notes.length > 0) otherLayers.push(acoustic);
    if (armed !== "vocal" && vocal.notes.length > 0) otherLayers.push(vocal);
    if (!drumIsRecordTarget && drum.notes.length > 0) otherLayers.push(drum);
    if (otherLayers.length > 0) {
      const overdub = new Playback(otherLayers, {
        onNoteOn: (_id, m) =>
          setPlaybackHighlight((cur) => {
            const next = new Set(cur);
            next.add(m);
            return next;
          }),
        onNoteOff: (_id, m) =>
          setPlaybackHighlight((cur) => {
            if (!cur.has(m)) return cur;
            const next = new Set(cur);
            next.delete(m);
            return next;
          }),
      });
      overdubRef.current = overdub;
      overdub.start();
    }

    // ドラム録音時は DrumLoop も自動で回し始める (鳴らした音がそのまま録音される)。
    // 主アーム=drum でなくとも、ドラム同時録音 ON のときも DrumLoop を回す。
    if (drumIsRecordTarget && drumPadRef.current && !drumPadRef.current.isPlaying()) {
      await drumPadRef.current.start();
    }

    setState("recording");
  }

  function stopRecord() {
    // raw モード時は録音後の自動クオンタイズをスキップして、手弾きのタイミングを
    // そのまま残す。auto モード時のみ拍グリッドにスナップする。
    const applyAutoCorrection = recordCorrectionMode === "auto";
    if (sessionRef.current) {
      const finished = sessionRef.current.end();
      const adjusted = applyAutoCorrection
        ? quantizeLayer({ ...finished }, quantizeGrid, bpm)
        : { ...finished };
      if (adjusted.id === "melody") setMelody(adjusted);
      else if (adjusted.id === "chord") setChord(adjusted);
      else if (adjusted.id === "bass") setBass(adjusted);
      else if (adjusted.id === "synth") setSynth(adjusted);
      else if (adjusted.id === "guitar") setGuitar(adjusted);
      else if (adjusted.id === "acoustic") setAcoustic(adjusted);
      else if (adjusted.id === "vocal") setVocal(adjusted);
      else setDrum(adjusted);
    }
    sessionRef.current = null;
    // 並列ドラムセッションの確定処理。
    if (drumSessionRef.current) {
      const finishedDrum = drumSessionRef.current.end();
      const adjustedDrum = applyAutoCorrection
        ? quantizeLayer({ ...finishedDrum }, quantizeGrid, bpm)
        : { ...finishedDrum };
      setDrum(adjustedDrum);
    }
    drumSessionRef.current = null;
    if (overdubRef.current) {
      overdubRef.current.stop();
      overdubRef.current = null;
    }
    cancelProgressionTimers();
    setState("idle");
    activeNotes.forEach((m) => {
      holdOff(m);
      bassHoldOff(m);
      synthHoldOff(m);
      guitarHoldOff(m);
      acousticHoldOff(m);
      vocalHoldOff(m);
    });
    setActiveNotes(new Set());
    setPlaybackHighlight(new Set());
  }

  function clearLayer(id: LayerId) {
    pushHistory();
    if (id === "melody") setMelody(emptyLayer("melody", "メロディ"));
    else if (id === "chord") setChord(emptyLayer("chord", "コード"));
    else if (id === "bass") setBass(emptyLayer("bass", "ベース"));
    else if (id === "synth") setSynth(emptyLayer("synth", "シンセ"));
    else if (id === "guitar") setGuitar(emptyLayer("guitar", "ギター"));
    else if (id === "acoustic") setAcoustic(emptyLayer("acoustic", "アコギ"));
    else if (id === "vocal") setVocal(emptyLayer("vocal", "ボーカル"));
    else setDrum(emptyLayer("drum", "ドラム"));
  }

  /** Library タブからの「このスロットをロードして」依頼を受けて、現在のセッションに読み込む。 */
  const loadSlotIntoStudio = useCallback(
    (slot: number) => {
      const data = loadSlot(slot);
      if (!data) {
        if (typeof window !== "undefined") {
          window.alert(`スロット ${slot} は空です。`);
        }
        return;
      }
      const currentlyHasAnything =
        melody.notes.length > 0 ||
        chord.notes.length > 0 ||
        drum.notes.length > 0 ||
        bass.notes.length > 0 ||
        synth.notes.length > 0 ||
        guitar.notes.length > 0 ||
        acoustic.notes.length > 0 ||
        vocal.notes.length > 0;
      if (
        currentlyHasAnything &&
        typeof window !== "undefined" &&
        !window.confirm(
          `スロット ${slot}「${data.name?.trim() || `スロット ${slot}`}」を読み込みます。現在の譜面は失われます (元に戻る で復元可)。よろしいですか？`,
        )
      ) {
        return;
      }
      pushHistory();
      setMelody(data.melody);
      setChord(data.chord);
      setDrum(data.drum);
      setBass(data.bass);
      setSynth(data.synth);
      setGuitar(data.guitar);
      setAcoustic(data.acoustic ?? emptyLayer("acoustic", "アコギ"));
      setVocal(data.vocal ?? emptyLayer("vocal", "ボーカル"));
      setBpm(data.bpm);
    },
    [melody, chord, drum, bass, synth, guitar, acoustic, vocal, pushHistory],
  );

  // storage イベントから常に最新の loadSlotIntoStudio を呼べるよう ref に同期。
  useEffect(() => {
    loadSlotRef.current = loadSlotIntoStudio;
  }, [loadSlotIntoStudio]);

  function openLibraryTab() {
    if (typeof window === "undefined") return;
    const url = buildLibraryUrl();
    window.open(url, "_blank", "noopener,noreferrer");
  }

  /** 全レイヤーのノートを一気にクリア。Undo で戻せる。 */
  function clearAllLayers() {
    if (!hasAnything) return;
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "全てのレイヤー (メロディ / コード / ベース / シンセ / ギター / アコギ / ボーカル / ドラム) の譜面を削除します。よろしいですか？ (元に戻る で復元可)",
      );
      if (!ok) return;
    }
    pushHistory();
    setMelody(emptyLayer("melody", "メロディ"));
    setChord(emptyLayer("chord", "コード"));
    setBass(emptyLayer("bass", "ベース"));
    setSynth(emptyLayer("synth", "シンセ"));
    setGuitar(emptyLayer("guitar", "ギター"));
    setAcoustic(emptyLayer("acoustic", "アコギ"));
    setVocal(emptyLayer("vocal", "ボーカル"));
    setDrum(emptyLayer("drum", "ドラム"));
  }

  // ---- 再生 -----------------------------------------------------------------
  async function startPlayback() {
    await arm();
    if (state === "recording") stopRecord();
    cancelProgressionTimers();
    // 録音した内容を再生する間はライブ DrumLoop を止める (二重発音防止)
    if (drumPadRef.current?.isPlaying()) drumPadRef.current.stop();
    const layers = [melody, chord, bass, synth, guitar, acoustic, vocal, drum].filter(
      (l) => l.notes.length > 0,
    );
    if (layers.length === 0) return;
    const pb = new Playback(layers, {
      onNoteOn: (_id, m) =>
        setPlaybackHighlight((cur) => {
          const next = new Set(cur);
          next.add(m);
          return next;
        }),
      onNoteOff: (_id, m) =>
        setPlaybackHighlight((cur) => {
          if (!cur.has(m)) return cur;
          const next = new Set(cur);
          next.delete(m);
          return next;
        }),
      onEnd: () => {
        setPlaying(false);
        setPlaybackHighlight(new Set());
      },
    });
    playbackRef.current = pb;
    pb.start(seekedSec);
    setPlaying(true);
  }

  /** PianoRoll の上部ルーラからシーク。再生中なら新位置から再開する。 */
  const handleSeek = useCallback((sec: number) => {
    const target = Math.max(0, sec);
    setSeekedSec(target);
    const pb = playbackRef.current;
    if (pb && pb.isPlaying()) {
      // 既存の再生を止めて、新位置から再開
      pb.stop();
      releaseAll();
      bassReleaseAll();
      synthReleaseAll();
      guitarReleaseAll();
      acousticReleaseAll();
      vocalReleaseAll();
      pb.start(target);
    }
  }, []);

  function stopPlayback() {
    if (playbackRef.current) playbackRef.current.stop();
    playbackRef.current = null;
    setPlaying(false);
    setPlaybackHighlight(new Set());
    releaseAll();
    bassReleaseAll();
    synthReleaseAll();
    guitarReleaseAll();
    acousticReleaseAll();
    vocalReleaseAll();
  }

  function cancelProgressionTimers() {
    progressionTimersRef.current.forEach((t) => window.clearTimeout(t));
    progressionTimersRef.current = [];
  }

  // ---- 自動作曲モード ------------------------------------------------------
  /**
   * AI が曲を生成 → リアルタイムでピアノロールに書き込みながら発音する。
   * 進行中は autoComposing=true、終了時または stop で false に戻る。
   */
  async function startAutoCompose() {
    if (autoComposing) return;
    // 他のオーディオ動作をすべて止める
    stopAll();
    if (!audioReady.current) {
      await ensureAudio();
      audioReady.current = true;
    }
    // 履歴に積んでから全レイヤを空にする (1 アクションで Undo できるように)
    pushHistory();
    setMelody((c) => ({ ...c, notes: [] }));
    setChord((c) => ({ ...c, notes: [] }));
    setBass((c) => ({ ...c, notes: [] }));
    setDrum((c) => ({ ...c, notes: [] }));

    const song = composeSong({
      scale,
      bpm,
      bars: autoComposeBars,
      style: autoComposeStyle,
    });

    setAutoComposing(true);
    setAutoComposeProgress({ pct: 0, bar: 1, totalBars: song.chords.length });

    const session = new AutoComposeSession(song, {
      onAddNote: (layerId, note) => {
        const append = (cur: Layer): Layer => ({
          ...cur,
          notes: [...cur.notes, note],
        });
        if (layerId === "melody") setMelody(append);
        else if (layerId === "chord") setChord(append);
        else if (layerId === "bass") setBass(append);
        else if (layerId === "drum") setDrum(append);
      },
      onProgress: (pct, bar) => {
        setAutoComposeProgress({ pct, bar, totalBars: song.chords.length });
      },
      onComplete: () => {
        setAutoComposing(false);
        autoComposeRef.current = null;
        // 終了時に念のため全エンジン解放
        releaseAll();
        bassReleaseAll();
        synthReleaseAll();
        guitarReleaseAll();
        acousticReleaseAll();
        vocalReleaseAll();
      },
    });
    autoComposeRef.current = session;
    session.start(autoComposeSpeed);
  }

  function stopAutoCompose() {
    if (autoComposeRef.current) {
      autoComposeRef.current.stop();
      autoComposeRef.current = null;
    }
    setAutoComposing(false);
    setAutoComposeProgress(null);
    releaseAll();
    bassReleaseAll();
    synthReleaseAll();
    guitarReleaseAll();
    acousticReleaseAll();
    vocalReleaseAll();
  }

  /**
   * 全層を BPM 基準のグリッドにスナップする。
   * 録音中・再生中は適用しない (誤動作防止)。
   * "off" のときは何もしない。
   */
  function applyQuantize() {
    if (state === "recording" || playing) return;
    if (quantizeGrid === "off") return;
    pushHistory();
    setMelody((cur) => quantizeLayer(cur, quantizeGrid, bpm));
    setChord((cur) => quantizeLayer(cur, quantizeGrid, bpm));
    setDrum((cur) => quantizeLayer(cur, quantizeGrid, bpm));
    setBass((cur) => quantizeLayer(cur, quantizeGrid, bpm));
    setSynth((cur) => quantizeLayer(cur, quantizeGrid, bpm));
    setGuitar((cur) => quantizeLayer(cur, quantizeGrid, bpm));
    setAcoustic((cur) => quantizeLayer(cur, quantizeGrid, bpm));
    setVocal((cur) => quantizeLayer(cur, quantizeGrid, bpm));
  }

  function exportMidi() {
    const layers = [melody, chord, bass, synth, guitar, acoustic, vocal, drum].filter(
      (l) => l.notes.length > 0,
    );
    if (layers.length === 0) return;
    const blob = exportToMidi(layers, "melodycatch.mid");
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .slice(0, 13);
    downloadBlob(blob, `MelodyCatch-${stamp}.mid`);
  }

  function stopAll() {
    stopPlayback();
    if (state === "recording") stopRecord();
    if (drumPadRef.current?.isPlaying()) drumPadRef.current.stop();
    if (autoComposeRef.current) {
      autoComposeRef.current.stop();
      autoComposeRef.current = null;
      setAutoComposing(false);
      setAutoComposeProgress(null);
    }
    cancelProgressionTimers();
    releaseAll();
    bassReleaseAll();
    synthReleaseAll();
    guitarReleaseAll();
    acousticReleaseAll();
    vocalReleaseAll();
    setActiveNotes(new Set());
    setPlaybackHighlight(new Set());
    setActiveChordIndex(null);
    setSpotlightLabel(null);
  }

  // ---- 手動編集ハンドラ -----------------------------------------------------
  // PianoRoll から「クリックでノート追加」「クリックでノート削除」「右端ドラッグでリサイズ」
  const handleAddNote = useCallback(
    (layerId: LayerId, midi: number, startSec: number) => {
      pushHistory();
      const dur =
        layerId === "drum" ? 0.05 : noteLengthToSec(noteLength, bpm);
      const note = { midi, startSec, durationSec: dur, velocity: 0.85 };
      const update = (cur: Layer): Layer => ({
        ...cur,
        notes: [...cur.notes, note].sort((a, b) => a.startSec - b.startSec),
      });
      if (layerId === "melody") setMelody(update);
      else if (layerId === "chord") setChord(update);
      else if (layerId === "bass") setBass(update);
      else if (layerId === "synth") setSynth(update);
      else if (layerId === "guitar") setGuitar(update);
      else if (layerId === "acoustic") setAcoustic(update);
      else if (layerId === "vocal") setVocal(update);
      else setDrum(update);
    },
    [pushHistory, noteLength, bpm],
  );

  const handleDeleteNote = useCallback(
    (layerId: LayerId, index: number) => {
      pushHistory();
      const update = (cur: Layer): Layer => ({
        ...cur,
        notes: cur.notes.filter((_, i) => i !== index),
      });
      if (layerId === "melody") setMelody(update);
      else if (layerId === "chord") setChord(update);
      else if (layerId === "bass") setBass(update);
      else if (layerId === "synth") setSynth(update);
      else if (layerId === "guitar") setGuitar(update);
      else if (layerId === "acoustic") setAcoustic(update);
      else if (layerId === "vocal") setVocal(update);
      else setDrum(update);
    },
    [pushHistory],
  );

  // リサイズ中は履歴を毎フレーム積まない (mousedown で 1 度だけ)。
  // setResizingPushed ref で初回のみ pushHistory する。
  const resizePushedRef = useRef(false);
  useEffect(() => {
    // どこかでリセット用 (useResize の onUp は PianoRoll 内なので
    // mouseup イベントを window 全体で拾って ref を戻す)
    function onUp() {
      resizePushedRef.current = false;
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const handleResizeNote = useCallback(
    (layerId: LayerId, index: number, durationSec: number, side: "right" | "left" = "right") => {
      if (!resizePushedRef.current) {
        pushHistory();
        resizePushedRef.current = true;
      }
      const update = (cur: Layer): Layer => ({
        ...cur,
        notes: cur.notes.map((n, i) => {
          if (i !== index) return n;
          if (side === "left") {
            // 左端を掴んでドラッグ: 終端 (start + duration) を固定したまま start と duration を更新
            const end = n.startSec + n.durationSec;
            const newDur = Math.max(0.05, durationSec);
            const newStart = Math.max(0, end - newDur);
            return { ...n, startSec: newStart, durationSec: end - newStart };
          }
          return { ...n, durationSec: Math.max(0.05, durationSec) };
        }),
      });
      if (layerId === "melody") setMelody(update);
      else if (layerId === "chord") setChord(update);
      else if (layerId === "bass") setBass(update);
      else if (layerId === "synth") setSynth(update);
      else if (layerId === "guitar") setGuitar(update);
      else if (layerId === "acoustic") setAcoustic(update);
      else if (layerId === "vocal") setVocal(update);
      else setDrum(update);
    },
    [pushHistory],
  );

  // ---- 範囲選択 / 一括編集 -------------------------------------------------
  // 移動中も毎フレーム履歴を積まないように、movePushedRef でドラッグ開始時の 1 度だけ pushHistory する。
  const movePushedRef = useRef(false);
  useEffect(() => {
    function onUp() {
      movePushedRef.current = false;
    }
    window.addEventListener("mouseup", onUp);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  /** 一括削除。selections は { layerId, index } の配列。 */
  const handleDeleteNotes = useCallback(
    (selections: { layerId: LayerId; index: number }[]) => {
      if (selections.length === 0) return;
      pushHistory();
      const byLayer = new Map<LayerId, Set<number>>();
      for (const s of selections) {
        if (!byLayer.has(s.layerId)) byLayer.set(s.layerId, new Set());
        byLayer.get(s.layerId)!.add(s.index);
      }
      const buildUpdate = (lid: LayerId) => (cur: Layer): Layer => {
        const idxs = byLayer.get(lid);
        if (!idxs) return cur;
        return { ...cur, notes: cur.notes.filter((_, i) => !idxs.has(i)) };
      };
      if (byLayer.has("melody")) setMelody(buildUpdate("melody"));
      if (byLayer.has("chord")) setChord(buildUpdate("chord"));
      if (byLayer.has("bass")) setBass(buildUpdate("bass"));
      if (byLayer.has("synth")) setSynth(buildUpdate("synth"));
      if (byLayer.has("guitar")) setGuitar(buildUpdate("guitar"));
      if (byLayer.has("acoustic")) setAcoustic(buildUpdate("acoustic"));
      if (byLayer.has("vocal")) setVocal(buildUpdate("vocal"));
      if (byLayer.has("drum")) setDrum(buildUpdate("drum"));
    },
    [pushHistory],
  );

  /**
   * 一括リサイズ。targets のノートそれぞれに対し、ドラッグ開始時の origStart/origDuration から
   * deltaSec を加減算する (右端=durationSec を増減 / 左端=startSec を増減して終端維持)。
   *
   * 単発リサイズ用 onResizeNote と異なり、各ターゲットのオリジナル値を毎フレーム参照するため、
   * ドラッグ中に「累積エラー」が起きない。
   */
  const handleResizeNotes = useCallback(
    (
      targets: {
        layerId: LayerId;
        index: number;
        origStartSec: number;
        origDurationSec: number;
      }[],
      deltaSec: number,
      side: "left" | "right",
    ) => {
      if (targets.length === 0) return;
      if (!resizePushedRef.current) {
        pushHistory();
        resizePushedRef.current = true;
      }
      const byLayer = new Map<
        LayerId,
        Map<number, { origStartSec: number; origDurationSec: number }>
      >();
      for (const t of targets) {
        if (!byLayer.has(t.layerId)) byLayer.set(t.layerId, new Map());
        byLayer.get(t.layerId)!.set(t.index, {
          origStartSec: t.origStartSec,
          origDurationSec: t.origDurationSec,
        });
      }
      const buildUpdate = (lid: LayerId) => (cur: Layer): Layer => {
        const map = byLayer.get(lid);
        if (!map) return cur;
        return {
          ...cur,
          notes: cur.notes.map((n, i) => {
            const orig = map.get(i);
            if (!orig) return n;
            if (side === "left") {
              const end = orig.origStartSec + orig.origDurationSec;
              const newDur = Math.max(0.05, orig.origDurationSec - deltaSec);
              const newStart = Math.max(0, end - newDur);
              return { ...n, startSec: newStart, durationSec: end - newStart };
            }
            const newDur = Math.max(0.05, orig.origDurationSec + deltaSec);
            return { ...n, durationSec: newDur };
          }),
        };
      };
      if (byLayer.has("melody")) setMelody(buildUpdate("melody"));
      if (byLayer.has("chord")) setChord(buildUpdate("chord"));
      if (byLayer.has("bass")) setBass(buildUpdate("bass"));
      if (byLayer.has("synth")) setSynth(buildUpdate("synth"));
      if (byLayer.has("guitar")) setGuitar(buildUpdate("guitar"));
      if (byLayer.has("acoustic")) setAcoustic(buildUpdate("acoustic"));
      if (byLayer.has("vocal")) setVocal(buildUpdate("vocal"));
      if (byLayer.has("drum")) setDrum(buildUpdate("drum"));
    },
    [pushHistory],
  );

  /**
   * 一括移動。selections のノートを (deltaSec, deltaMidi) だけずらす。
   * - deltaMidi はドラム層では無視される (キット番号を変えると音色が変わるため)。
   * - インデックス番号は移動中もずれない (ドラッグ開始時のスナップショットに対応)
   *   ようにするため、ここでは sort せず、index 位置のまま値だけ更新する。
   */
  const handleMoveNotes = useCallback(
    (
      selections: { layerId: LayerId; index: number }[],
      deltaSec: number,
      deltaMidi: number,
    ) => {
      if (selections.length === 0) return;
      if (!movePushedRef.current) {
        pushHistory();
        movePushedRef.current = true;
      }
      const byLayer = new Map<LayerId, Set<number>>();
      for (const s of selections) {
        if (!byLayer.has(s.layerId)) byLayer.set(s.layerId, new Set());
        byLayer.get(s.layerId)!.add(s.index);
      }
      const buildUpdate = (lid: LayerId) => (cur: Layer): Layer => {
        const idxs = byLayer.get(lid);
        if (!idxs) return cur;
        const isDrum = lid === "drum";
        return {
          ...cur,
          notes: cur.notes.map((n, i) => {
            if (!idxs.has(i)) return n;
            const newStart = Math.max(0, n.startSec + deltaSec);
            const newMidi = isDrum
              ? n.midi
              : Math.max(21, Math.min(108, n.midi + deltaMidi));
            return { ...n, startSec: newStart, midi: newMidi };
          }),
        };
      };
      if (byLayer.has("melody")) setMelody(buildUpdate("melody"));
      if (byLayer.has("chord")) setChord(buildUpdate("chord"));
      if (byLayer.has("bass")) setBass(buildUpdate("bass"));
      if (byLayer.has("synth")) setSynth(buildUpdate("synth"));
      if (byLayer.has("guitar")) setGuitar(buildUpdate("guitar"));
      if (byLayer.has("acoustic")) setAcoustic(buildUpdate("acoustic"));
      if (byLayer.has("vocal")) setVocal(buildUpdate("vocal"));
      if (byLayer.has("drum")) setDrum(buildUpdate("drum"));
    },
    [pushHistory],
  );

  // ---- メトロノーム (BPM 連動) ---------------------------------------------
  // ON 状態かつ「録音中 または 再生中」のときだけ鳴らす。
  // ON だけでは鳴らない (静かな練習中にノイズを出さない)。
  useEffect(() => {
    if (!metronomeOn) return;
    if (state !== "recording" && !playing) return;
    let cancelled = false;
    (async () => {
      await arm();
      if (!cancelled) startMetronome(bpm);
    })();
    return () => {
      cancelled = true;
      stopMetronome();
    };
  }, [metronomeOn, state, playing, arm, bpm]);

  // BPM 変更時にメトロノームの BPM をライブ更新
  useEffect(() => {
    if (metronomeOn) setMetronomeBpm(bpm);
  }, [bpm, metronomeOn]);

  // ---- BPM 変更時に既存ノートを再スケール ---------------------------------
  // ある BPM で録音した内容を BPM 変更後に再生すると元のテンポのままになってしまうため、
  // BPM 比に応じて startSec / durationSec をスケールし直す。
  // 録音中・再生中はテンポずれの原因になるのでスキップ。
  const prevBpmRef = useRef(bpm);
  useEffect(() => {
    const prev = prevBpmRef.current;
    if (prev === bpm) return;
    if (state === "recording" || playing) {
      prevBpmRef.current = bpm;
      return;
    }
    const scale = prev / bpm; // 新 BPM が速いほど時間は短くなる
    const rescale = (layer: Layer): Layer => ({
      ...layer,
      notes: layer.notes.map((n) => ({
        ...n,
        startSec: n.startSec * scale,
        durationSec: n.durationSec * scale,
      })),
    });
    setMelody(rescale);
    setChord(rescale);
    setBass(rescale);
    setSynth(rescale);
    setGuitar(rescale);
    setAcoustic(rescale);
    setVocal(rescale);
    setDrum(rescale);
    prevBpmRef.current = bpm;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpm]);

  // ---- アンマウント時クリーンアップ ----------------------------------------
  useEffect(() => {
    return () => {
      if (playbackRef.current) playbackRef.current.stop();
      if (overdubRef.current) overdubRef.current.stop();
      cancelProgressionTimers();
      releaseAll();
      bassReleaseAll();
      synthReleaseAll();
      guitarReleaseAll();
      acousticReleaseAll();
      vocalReleaseAll();
      stopMetronome();
    };
  }, []);

  // ---- UI -------------------------------------------------------------------
  const melodyDur = useMemo(() => layerDuration(melody), [melody]);
  const chordDur = useMemo(() => layerDuration(chord), [chord]);
  const drumDur = useMemo(() => layerDuration(drum), [drum]);
  const bassDur = useMemo(() => layerDuration(bass), [bass]);
  const synthDur = useMemo(() => layerDuration(synth), [synth]);
  const guitarDur = useMemo(() => layerDuration(guitar), [guitar]);
  const acousticDur = useMemo(() => layerDuration(acoustic), [acoustic]);
  const vocalDur = useMemo(() => layerDuration(vocal), [vocal]);
  const totalDur = Math.max(
    melodyDur,
    chordDur,
    drumDur,
    bassDur,
    synthDur,
    guitarDur,
    acousticDur,
    vocalDur,
  );
  const hasAnything =
    melody.notes.length > 0 ||
    chord.notes.length > 0 ||
    drum.notes.length > 0 ||
    bass.notes.length > 0 ||
    synth.notes.length > 0 ||
    guitar.notes.length > 0 ||
    acoustic.notes.length > 0 ||
    vocal.notes.length > 0;
  const overdubPlaying =
    state === "recording" &&
    ((armed !== "melody" && melody.notes.length > 0) ||
      (armed !== "chord" && chord.notes.length > 0) ||
      (armed !== "bass" && bass.notes.length > 0) ||
      (armed !== "synth" && synth.notes.length > 0) ||
      (armed !== "guitar" && guitar.notes.length > 0) ||
      (armed !== "acoustic" && acoustic.notes.length > 0) ||
      (armed !== "vocal" && vocal.notes.length > 0) ||
      (armed !== "drum" && drum.notes.length > 0));
  const isActive = state === "recording" || playing;
  const recordingLayerId: LayerId | null =
    state === "recording" ? armed : null;
  const trackInfo: { id: LayerId; layer: Layer; label: string }[] = [
    { id: "melody", layer: melody, label: "🎵 メロディ層" },
    { id: "chord", layer: chord, label: "🎼 コード層" },
    { id: "bass", layer: bass, label: "🎸 ベース層" },
    { id: "synth", layer: synth, label: "🎹 シンセ層" },
    { id: "guitar", layer: guitar, label: "🎸 ギター層" },
    { id: "acoustic", layer: acoustic, label: "🎸 アコギ層" },
    { id: "vocal", layer: vocal, label: "🎤 ボーカル層" },
    { id: "drum", layer: drum, label: "🥁 ドラム層" },
  ];
  const armedLabel =
    armed === "melody"
      ? "メロディ"
      : armed === "chord"
        ? "コード"
        : armed === "bass"
          ? "ベース"
          : armed === "synth"
            ? "シンセ"
            : armed === "guitar"
              ? "ギター"
              : armed === "acoustic"
                ? "アコギ"
                : armed === "vocal"
                  ? "ボーカル"
                  : "ドラム";
  const progressionGapSec = (60 * 4) / Math.max(40, Math.min(220, bpm));

  return (
    <div className="flex flex-col gap-6">
      {/* ① キー / スケール */}
      <section className="rounded-2xl border border-ink-200 bg-pink-100 p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-700">
            ① 曲のキーとスケールを選ぶ
          </h2>
          <button
            type="button"
            onClick={stopAll}
            className="rounded-full border border-ink-200 bg-white px-3 py-1 text-xs font-medium text-ink-700 hover:border-accent-300"
          >
            音を止める
          </button>
        </div>
        <ScalePicker scale={scale} onChange={onScaleChange} />
      </section>

      {/* ② ドラム */}
      <section
        className={[
          "rounded-2xl border bg-cyan-100 p-4 shadow-sm transition",
          armed === "drum" ? "border-accent-300" : "border-ink-200",
        ].join(" ")}
      >
        <h2 className="mb-3 text-sm font-semibold text-ink-700">
          ② ドラム (5 パターン + 自由編集){" "}
          {armed === "drum" && state === "recording"
            ? `🥁 録音中 (+${drumRecCount} ヒット)`
            : armed === "drum"
              ? "🥁 ドラム層に録音可"
              : ""}
        </h2>
        <DrumPad
          ref={drumPadRef}
          bpm={bpm}
          onBpmChange={setBpm}
          onHit={handleDrumHit}
        />
        <p className="mt-3 text-xs text-ink-500">
          パターン選択 → 各セルでヒットを増減 → ▶ でループ。BPM はコード進行プリセットとも連動します
          (1 コード = 1 小節)。
        </p>
      </section>

      {/* 入力ステータス */}
      <section className="rounded-2xl border border-ink-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
          <span className="rounded-full bg-ink-100 px-2 py-1">
            ⌨️ <b>Q W E R T Y U I O P</b> 白鍵 / <b>2 3 5 6 7 9 0</b> 黒鍵 / <b>Z X</b> オクターブ↓↑
          </span>
          <span className="rounded-full bg-ink-100 px-2 py-1">
            🎹 MIDI:{" "}
            {!midi.supported
              ? "ブラウザ非対応"
              : midi.error
                ? `エラー: ${midi.error}`
                : midi.devices.length > 0
                  ? midi.devices.join(" / ")
                  : "未接続"}
          </span>
        </div>
      </section>

      {/* 🤖 自動作曲モード */}
      <section className="rounded-2xl border border-violet-300 bg-gradient-to-br from-violet-50 to-fuchsia-50 p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-violet-800">
            🤖 自動作曲モード (AI がリアルタイムで打ち込み)
          </h2>
          {autoComposing && autoComposeProgress && (
            <span className="text-xs font-mono tabular-nums text-violet-700">
              {autoComposeProgress.bar} / {autoComposeProgress.totalBars} 小節
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          {/* スタイル */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-violet-700">
              スタイル
            </label>
            <select
              value={autoComposeStyle}
              onChange={(e) => setAutoComposeStyle(e.target.value as ComposerStyle)}
              disabled={autoComposing}
              className="w-full rounded-lg border border-violet-300 bg-white px-2 py-1.5 text-sm text-ink-800 disabled:opacity-50"
            >
              {(Object.keys(COMPOSER_STYLE_LABEL_JA) as ComposerStyle[]).map((s) => (
                <option key={s} value={s}>
                  {COMPOSER_STYLE_LABEL_JA[s]}
                </option>
              ))}
            </select>
          </div>
          {/* 小節数 */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-violet-700">
              小節数
            </label>
            <select
              value={autoComposeBars}
              onChange={(e) => setAutoComposeBars(Number(e.target.value))}
              disabled={autoComposing}
              className="w-full rounded-lg border border-violet-300 bg-white px-2 py-1.5 text-sm text-ink-800 disabled:opacity-50"
            >
              <option value={8}>8 小節 (短め)</option>
              <option value={16}>16 小節 (標準)</option>
              <option value={32}>32 小節 (長め)</option>
            </select>
          </div>
          {/* 早送り */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-violet-700">
              書き込み速度
            </label>
            <select
              value={autoComposeSpeed}
              onChange={(e) => setAutoComposeSpeed(Number(e.target.value))}
              disabled={autoComposing}
              className="w-full rounded-lg border border-violet-300 bg-white px-2 py-1.5 text-sm text-ink-800 disabled:opacity-50"
            >
              <option value={1}>1x (実時間)</option>
              <option value={2}>2x (早回し)</option>
              <option value={4}>4x (高速)</option>
              <option value={8}>8x (超高速)</option>
            </select>
          </div>
          {/* 開始 / 停止 */}
          <div className="flex items-end">
            {autoComposing ? (
              <button
                type="button"
                onClick={stopAutoCompose}
                className="w-full rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white shadow hover:bg-rose-700"
              >
                ■ 停止
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void startAutoCompose();
                }}
                className="w-full rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white shadow hover:bg-violet-700"
              >
                🤖 自動作曲 開始
              </button>
            )}
          </div>
        </div>
        {autoComposing && autoComposeProgress && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-violet-200">
            <div
              className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-200"
              style={{ width: `${Math.round(autoComposeProgress.pct * 100)}%` }}
            />
          </div>
        )}
        <p className="mt-2 text-[11px] text-violet-700/80">
          ※ 既存のメロディ / コード / ベース / ドラム層は空にされてから書き込まれます (Undo で復元可)。
          スケール ({scaleDisplayName(scale)}) と BPM ({bpm}) は現在の設定が使われます。
        </p>
      </section>

      {/* ③ 録音トラック (ピアノロールの上に配置: ピアノロールを見ながら録音できるように) */}
      <section className="rounded-2xl border border-ink-200 bg-blue-100 p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-700">
            ③ 録音トラック (録音したい時だけ使う)
          </h2>
          <div className="text-xs font-mono tabular-nums text-ink-600">
            {state === "recording" ? "● REC " : playing ? "▶ PLAY " : "■ "}
            {elapsed.toFixed(1)}s
            {totalDur > 0 && ` / ${totalDur.toFixed(1)}s`}
            {overdubPlaying && (
              <span className="ml-2 text-accent-700">+ オーバーダブ再生中</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {trackInfo.map(({ id, layer, label }) => {
            const isArmed = armed === id;
            const dur = layerDuration(layer);
            const isRec = state === "recording";
            return (
              <div key={id} className="flex flex-col gap-2">
                <button
                  type="button"
                  role="radio"
                  aria-checked={isArmed}
                  onClick={() => {
                    if (isRec) return;
                    setArmed(id);
                  }}
                  disabled={isRec}
                  className={[
                    "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition",
                    "active:scale-[0.99] disabled:cursor-not-allowed",
                    isArmed
                      ? "border-accent-500 bg-accent-50 ring-2 ring-accent-300/60"
                      : "border-ink-200 bg-white hover:border-accent-300",
                    isRec && !isArmed ? "opacity-40" : "",
                  ].join(" ")}
                >
                  <span className="flex items-center gap-3">
                    <span
                      className={[
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition",
                        isArmed
                          ? "border-accent-500 bg-accent-500"
                          : "border-ink-300 bg-white",
                      ].join(" ")}
                      aria-hidden
                    >
                      {isArmed && (
                        <span className="h-2.5 w-2.5 rounded-full bg-white" />
                      )}
                    </span>
                    <span className="text-base font-semibold">{label}</span>
                    {id === "vocal" && !vocalSampleReady && (
                      <span className="ml-1 animate-pulse rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        サンプル読み込み中…
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-ink-500">
                    {id === "drum"
                      ? `${layer.notes.length} ヒット`
                      : `${layer.notes.length} ノート`}{" "}
                    / {dur.toFixed(1)}s
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => clearLayer(id)}
                  disabled={isRec || layer.notes.length === 0}
                  className="self-start rounded-full border border-ink-200 bg-white px-3 py-1 text-xs text-ink-700 disabled:cursor-not-allowed disabled:opacity-40 hover:border-accent-300"
                >
                  クリア
                </button>
              </div>
            );
          })}
        </div>

        {/* 録音補正モード切替: 拍グリッドに揃える auto と、手弾きのままの raw */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-600">録音補正:</span>
          <div className="inline-flex overflow-hidden rounded-full border border-ink-200 bg-white">
            <button
              type="button"
              onClick={() => {
                if (state === "recording") return;
                setRecordCorrectionMode("auto");
              }}
              disabled={state === "recording"}
              className={[
                "px-3 py-1 text-xs font-semibold transition",
                recordCorrectionMode === "auto"
                  ? "bg-accent-500 text-white"
                  : "text-ink-600 hover:bg-ink-50",
                state === "recording" ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
              title="拍グリッドに自動でスナップ・クオンタイズします"
            >
              自動補正
            </button>
            <button
              type="button"
              onClick={() => {
                if (state === "recording") return;
                setRecordCorrectionMode("raw");
              }}
              disabled={state === "recording"}
              className={[
                "px-3 py-1 text-xs font-semibold transition",
                recordCorrectionMode === "raw"
                  ? "bg-accent-500 text-white"
                  : "text-ink-600 hover:bg-ink-50",
                state === "recording" ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
              title="手弾きのタイミングそのままで記録します (スナップ・クオンタイズなし)"
            >
              そのまま
            </button>
          </div>
          <span className="text-xs text-ink-500">
            {recordCorrectionMode === "auto"
              ? "ドラムは拍にスナップ・全層を録音停止時にクオンタイズします"
              : "手弾きのタイミングを一切補正しません"}
          </span>
        </div>

        {/* ベースタイプ切替: ウッド / シンセ / スラップ */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-600">🎸 ベース音色:</span>
          <div className="inline-flex overflow-hidden rounded-full border border-ink-200 bg-white">
            {(["wood", "synth", "slap"] as const).map((t) => {
              const label = t === "wood" ? "ウッド" : t === "synth" ? "シンセ" : "スラップ";
              const title =
                t === "wood"
                  ? "アップライト/ウッドベース (丸く太い、歪みなし)"
                  : t === "synth"
                    ? "シンセベース (鋸波・共振フィルタ・パワフル)"
                    : "スラップベース (鋭いアタック、明るい中域、カンというノイズ)";
              const active = bassType === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    bassReleaseAll();
                    setBassTypeState(t);
                  }}
                  className={[
                    "px-3 py-1 text-xs font-semibold transition",
                    active
                      ? "bg-accent-500 text-white"
                      : "text-ink-600 hover:bg-ink-50",
                  ].join(" ")}
                  title={title}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-ink-500">
            {bassType === "wood"
              ? "アップライト風: 木の胴鳴り、丸く短い減衰"
              : bassType === "synth"
                ? "シンセ風: 鋸波と共振フィルタでパワフル"
                : "スラップ風: 鋭いプラックと「カン」というアタック"}
          </span>
        </div>

        {/* ギタータイプ切替: クリーン / ディストーション */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-600">🎸 ギター音色:</span>
          <div className="inline-flex overflow-hidden rounded-full border border-ink-200 bg-white">
            {(["clean", "distortion"] as const).map((t) => {
              const label = t === "clean" ? "クリーン" : "ディストーション";
              const title =
                t === "clean"
                  ? "クリーントーン (歪みなし、開いた高域、軽いコーラスとリバーブ)"
                  : "ディストーション (歪み+チェビシェフ倍音、ハードロック系エレキ)";
              const active = guitarType === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    guitarReleaseAll();
                    setGuitarTypeState(t);
                  }}
                  className={[
                    "px-3 py-1 text-xs font-semibold transition",
                    active
                      ? "bg-accent-500 text-white"
                      : "text-ink-600 hover:bg-ink-50",
                  ].join(" ")}
                  title={title}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-ink-500">
            {guitarType === "clean"
              ? "クリーン: 歪みなし、コードやアルペジオに合う"
              : "ディストーション: 歪み+倍音強調、ハードロック系"}
          </span>
        </div>

        {/* ボーカル母音切替: アー / ウー / んー */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-600">🎤 ボーカル母音:</span>
          <div className="inline-flex overflow-hidden rounded-full border border-ink-200 bg-white">
            {(["aah", "ooh", "hum"] as const).map((v) => {
              const label = v === "aah" ? "アー" : v === "ooh" ? "ウー" : "んー";
              const title =
                v === "aah"
                  ? "Choir Aahs: 開いた明るい「アー」(賛美歌・聖歌隊風)"
                  : v === "ooh"
                    ? "Voice Oohs: 丸く柔らかい「ウー」(コーラスバッキング向き)"
                    : "Hum: 閉口音「んー」(Voice Oohs をローパスで暗くした)";
              const active = vocalVowel === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    vocalReleaseAll();
                    setVocalVowelState(v);
                  }}
                  className={[
                    "px-3 py-1 text-xs font-semibold transition",
                    active
                      ? "bg-accent-500 text-white"
                      : "text-ink-600 hover:bg-ink-50",
                  ].join(" ")}
                  title={title}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-ink-500">
            {vocalVowel === "aah"
              ? "「アー」: 明るい合唱"
              : vocalVowel === "ooh"
                ? "「ウー」: 柔らかいコーラス"
                : "「んー」: 閉口ハミング"}
          </span>
        </div>

        {/* ボーカル子音アタック切替: 各ノート頭に短い「ラ/タ/ナ/マ/パ」風バーストを挿入 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-600">🎤 子音アタック:</span>
          <div className="inline-flex overflow-hidden rounded-full border border-ink-200 bg-white">
            {(["none", "la", "ta", "na", "ma", "pa"] as const).map((c) => {
              const label =
                c === "none" ? "なし" : c === "la" ? "ラ" : c === "ta" ? "タ" : c === "na" ? "ナ" : c === "ma" ? "マ" : "パ";
              const title =
                c === "none"
                  ? "子音なし、母音だけで発音"
                  : c === "la"
                    ? "ラ: 中域の柔らかいバースト (舌打ち風)"
                    : c === "ta"
                      ? "タ: 高域の鋭いトランジェント"
                      : c === "na"
                        ? "ナ: 鼻腔共鳴 (バンドパス 250Hz)"
                        : c === "ma"
                          ? "マ: 唇開放、暗めの低域"
                          : "パ: 唇破裂の中域バースト";
              const active = vocalSyllable === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setVocalSyllableState(c)}
                  className={[
                    "px-3 py-1 text-xs font-semibold transition",
                    active ? "bg-accent-500 text-white" : "text-ink-600 hover:bg-ink-50",
                  ].join(" ")}
                  title={title}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-ink-500">
            {vocalSyllable === "none"
              ? "ノートの頭に子音を入れない"
              : `各ノートの頭に「${vocalSyllable === "la" ? "ラ" : vocalSyllable === "ta" ? "タ" : vocalSyllable === "na" ? "ナ" : vocalSyllable === "ma" ? "マ" : "パ"}」風バーストを挿入`}
          </span>
        </div>

        {/* ボーカル表現切替: ビブラート/しゃくり/レガートをまとめてプリセット */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-600">🎤 表現:</span>
          <div className="inline-flex overflow-hidden rounded-full border border-ink-200 bg-white">
            {(["flat", "natural", "expressive"] as const).map((e) => {
              const label = e === "flat" ? "フラット" : e === "natural" ? "ナチュラル" : "エモい";
              const title =
                e === "flat"
                  ? "ビブラート無し、release も短め (機械的)"
                  : e === "natural"
                    ? "薄めビブラート (5Hz, 1.5%) + ゆるめ release"
                    : "深めビブラート (5.5Hz, 3%) + 各ノート頭に -40cent しゃくり + 長め release";
              const active = vocalExpression === e;
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => setVocalExpressionState(e)}
                  className={[
                    "px-3 py-1 text-xs font-semibold transition",
                    active ? "bg-accent-500 text-white" : "text-ink-600 hover:bg-ink-50",
                  ].join(" ")}
                  title={title}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-ink-500">
            {vocalExpression === "flat"
              ? "機械的、揺らぎなし"
              : vocalExpression === "natural"
                ? "薄いビブラート + 自然な余韻"
                : "深いビブラート + しゃくり + 長い余韻"}
          </span>
        </div>

        {/* ドラム同時録音トグル: 主アーム楽器とは別にドラム層へ並行録音できる */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label
            className={[
              "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
              armed === "drum"
                ? "cursor-not-allowed border-ink-200 bg-ink-50 text-ink-400"
                : drumAlsoArmed
                  ? "border-accent-500 bg-accent-50 text-accent-700"
                  : "border-ink-200 bg-white text-ink-700 hover:border-accent-300",
              state === "recording" ? "cursor-not-allowed opacity-60" : "",
            ].join(" ")}
            title={
              armed === "drum"
                ? "ドラムが主アーム楽器のため、同時録音オプションは不要です"
                : "ON にすると、選択した楽器と一緒にドラムも同時に録音されます"
            }
          >
            <input
              type="checkbox"
              checked={drumAlsoArmed && armed !== "drum"}
              disabled={armed === "drum" || state === "recording"}
              onChange={(e) => setDrumAlsoArmed(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent-500"
            />
            🥁 ドラムも同時に録音する
          </label>
          {drumAlsoArmed && armed !== "drum" && state === "recording" && (
            <span className="text-xs font-medium text-accent-700">
              + ドラム並行録音中 ({drumRecCount} ヒット)
            </span>
          )}
        </div>

        <p className="mt-3 text-xs text-ink-500">
          層を選んでピアノロール下の「録音」ボタンで録音開始 / 停止。録音中は録音対象以外のレイヤが同時再生されます (DAW 風オーバーダブ)。
          ドラム層を録音中はドラムループも自動で回ります。下のピアノロールを見ながら録音できます。
          「ドラムも同時に録音する」を ON にすると、選んだ楽器と一緒にドラム層へも並行録音できます。
        </p>
      </section>

      {/* ④ ピアノロール */}
      <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-700">
            ④ ピアノロール (DAW 風 / ドラムレーン付き)
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
            <span>横:時間 / 縦:音程</span>
            <button
              type="button"
              onClick={undo}
              disabled={past.length === 0 || state === "recording"}
              title="元に戻る (Cmd/Ctrl+Z)"
              className="rounded-full border border-ink-300 bg-white px-2 py-0.5 text-xs font-medium text-ink-700 hover:border-accent-300 disabled:opacity-40"
            >
              ↶ 元に戻る
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={future.length === 0 || state === "recording"}
              title="やり直し (Cmd/Ctrl+Shift+Z)"
              className="rounded-full border border-ink-300 bg-white px-2 py-0.5 text-xs font-medium text-ink-700 hover:border-accent-300 disabled:opacity-40"
            >
              ↷ やり直し
            </button>
            <button
              type="button"
              onClick={() => {
                setEditMode((v) => {
                  const next = !v;
                  // OFF にするときはサブモード (消しゴム) も解除。
                  if (!next) setEraserMode(false);
                  return next;
                });
              }}
              disabled={state === "recording" || playing}
              title={`編集モード ON のときは、ピアノロール上をクリックしてノートを追加 / 既存ノートをドラッグで自由移動 / 両端ドラッグで長さ変更 / 空エリアをドラッグで範囲選択 → Delete で一括削除 / Esc で選択解除。${armedLabel}層が編集対象です。`}
              className={[
                "rounded-full px-3 py-0.5 text-xs font-semibold shadow-sm disabled:opacity-40",
                editMode
                  ? "bg-rose-500 text-white hover:bg-rose-600"
                  : "border border-ink-300 bg-white text-ink-700 hover:border-accent-300",
              ].join(" ")}
            >
              ✎ 編集モード {editMode ? "ON" : "OFF"}
            </button>
            {/* 編集モード ON のときだけサブモード切り替え (通常 / 消しゴム) を表示。 */}
            {editMode && (
              <div
                className="inline-flex items-center gap-0.5 rounded-full border border-ink-300 bg-white p-0.5 shadow-sm"
                role="group"
                aria-label="編集サブモード"
              >
                <button
                  type="button"
                  onClick={() => setEraserMode(false)}
                  disabled={state === "recording" || playing}
                  title="通常: クリックでノート追加 / ドラッグで移動・リサイズ・範囲選択。"
                  className={[
                    "rounded-full px-2.5 py-0.5 text-xs font-semibold transition disabled:opacity-40",
                    !eraserMode
                      ? "bg-rose-500 text-white"
                      : "text-ink-700 hover:bg-ink-100",
                  ].join(" ")}
                  aria-pressed={!eraserMode}
                >
                  ✎ 通常
                </button>
                <button
                  type="button"
                  onClick={() => setEraserMode(true)}
                  disabled={state === "recording" || playing}
                  title="消しゴム: ピアノロール上のノートをクリックすると即削除します。"
                  className={[
                    "rounded-full px-2.5 py-0.5 text-xs font-semibold transition disabled:opacity-40",
                    eraserMode
                      ? "bg-amber-500 text-white"
                      : "text-ink-700 hover:bg-ink-100",
                  ].join(" ")}
                  aria-pressed={eraserMode}
                >
                  🧽 消しゴム
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={clearAllLayers}
              disabled={state === "recording" || playing || !hasAnything}
              title="全てのレイヤー (メロディ / コード / ベース / シンセ / ギター / アコギ / ドラム) の譜面を一気に削除します。「元に戻る」で復元できます。"
              className="rounded-full border border-rose-300 bg-white px-3 py-0.5 text-xs font-semibold text-rose-600 shadow-sm hover:bg-rose-50 disabled:opacity-40"
            >
              🗑 譜面を削除
            </button>
            <label className="flex items-center gap-1">
              <span className="font-medium text-ink-700">音の長さ</span>
              <select
                value={noteLength}
                onChange={(e) =>
                  setNoteLength(e.target.value as NoteLength)
                }
                disabled={state === "recording" || playing}
                title="編集モードで追加するノートの長さ。BPM 連動で 1/4〜1/32、または自由 (0.5秒固定)。"
                className="rounded-md border border-ink-300 bg-white px-2 py-0.5 text-xs disabled:opacity-50"
              >
                <option value="1/4">1/4</option>
                <option value="1/8">1/8</option>
                <option value="1/16">1/16</option>
                <option value="1/32">1/32</option>
                <option value="free">自由 (0.5s)</option>
              </select>
            </label>
            <button
              type="button"
              onClick={async () => {
                await arm();
                setMetronomeOn((v) => !v);
              }}
              title={`メトロノーム ${metronomeOn ? "OFF" : "ON"} (BPM ${bpm} 連動)`}
              className={[
                "rounded-full px-3 py-0.5 text-xs font-semibold shadow-sm",
                metronomeOn
                  ? "bg-emerald-500 text-white hover:bg-emerald-600"
                  : "border border-ink-300 bg-white text-ink-700 hover:border-accent-300",
              ].join(" ")}
            >
              🎵 メトロノーム {metronomeOn ? "ON" : "OFF"}
            </button>
            <label className="flex items-center gap-1">
              <span className="font-medium text-ink-700">クオンタイズ</span>
              <select
                value={quantizeGrid}
                onChange={(e) =>
                  setQuantizeGrid(e.target.value as QuantizeGrid)
                }
                disabled={state === "recording" || playing}
                className="rounded-md border border-ink-300 bg-white px-2 py-0.5 text-xs disabled:opacity-50"
              >
                <option value="off">OFF</option>
                <option value="1/4">1/4 (拍)</option>
                <option value="1/8">1/8</option>
                <option value="1/16">1/16</option>
                <option value="1/32">1/32</option>
              </select>
            </label>
            <button
              type="button"
              onClick={applyQuantize}
              disabled={
                state === "recording" ||
                playing ||
                quantizeGrid === "off" ||
                !hasAnything
              }
              title={`BPM ${bpm} を基準に全層を ${quantizeGrid} にスナップします。例: 7秒付近のコードとドラムが同じグリッドに揃って同時に鳴ります。`}
              className="rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-accent-600 disabled:opacity-40"
            >
              ▣ クオンタイズ実行
            </button>
          </div>
        </div>
        {editMode && !eraserMode && (
          <div className="mb-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
            ✎ 編集モード (通常): 空の場所をドラッグで範囲選択 / クリックで <b>{armedLabel}層</b> にノート追加 (長さ <b>{noteLength}</b>、ドラムは 1 ヒット)。
            ノートをドラッグで自由に移動 (時間 + 音程)。両端を掴むと長さ調整 (範囲選択中は全ノートが同じ量だけ伸縮)。
            選択中に <b>Delete</b>/<b>Backspace</b> で一括削除、<b>Esc</b> で選択解除。
            移動・リサイズは小節グリッドへスナップ (右上のセレクタで分解能を変更)。
            <b>Cmd</b> / <b>Ctrl</b> を押しながら操作するとスナップを一時的に無効化。
          </div>
        )}
        {editMode && eraserMode && (
          <div className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            🧽 編集モード (消しゴム): ピアノロール上のノートをクリックすると即削除します。
            通常編集に戻すには上の <b>「✎ 通常」</b> を選択してください。
          </div>
        )}
        <div data-pianoroll-area="1">
          <PianoRoll
            melody={melody}
            chord={chord}
            drum={drum}
            bass={bass}
            synth={synth}
            guitar={guitar}
            acoustic={acoustic}
            vocal={vocal}
            isActive={isActive}
            recordingLayerId={recordingLayerId}
            getPlayheadSec={getPlayheadSec}
            bpm={bpm}
            editMode={editMode}
            eraserMode={eraserMode}
            armedLayer={armed}
            onAddNote={handleAddNote}
            onDeleteNote={handleDeleteNote}
            onResizeNote={handleResizeNote}
            onResizeNotes={handleResizeNotes}
            onDeleteNotes={handleDeleteNotes}
            onMoveNotes={handleMoveNotes}
            onSeek={handleSeek}
          />
        </div>
        {/* 再生 / 録音 / 書き出し (ピアノロール直下) */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!playing ? (
            <button
              type="button"
              onClick={startPlayback}
              disabled={state === "recording" || !hasAnything}
              className="rounded-full bg-accent-500 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent-600 disabled:opacity-40"
            >
              ▶ 再生
            </button>
          ) : (
            <button
              type="button"
              onClick={stopPlayback}
              className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-sm"
            >
              ■ 停止
            </button>
          )}
          {state === "idle" ? (
            <button
              type="button"
              onClick={startRecord}
              disabled={playing}
              className="rounded-full bg-rose-500 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-600 disabled:opacity-40"
            >
              ● {armedLabel} を録音
            </button>
          ) : (
            <button
              type="button"
              onClick={stopRecord}
              className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-sm"
            >
              ■ 停止
            </button>
          )}
          <button
            type="button"
            onClick={exportMidi}
            disabled={!hasAnything}
            className="rounded-full border border-ink-300 bg-white px-5 py-2 text-sm font-semibold text-ink-700 shadow-sm hover:border-accent-300 disabled:opacity-40"
          >
            ⤓ MIDIファイル書き出し
          </button>
        </div>

      </section>

      {/* ⑤ 入力カルーセル: コードパレット → スケールミニピアノ → 88鍵ピアノ */}
      <section
        className={[
          "rounded-2xl border bg-lime-100 p-4 shadow-sm transition",
          armed === "chord" ? "border-accent-300" : "border-ink-200",
        ].join(" ")}
      >
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-700">
            ⑤ 入力 (コードパレット ↔ スケールミニピアノ ↔ 88鍵ピアノ)
            {armed === "chord" && state === "recording" && (
              <span className="ml-2 text-rose-500">
                🎼 コード層に録音中 (+{chordRecCount} コード)
              </span>
            )}
            {armed === "melody" && state === "recording" && (
              <span className="ml-2 text-rose-500">● メロディ層に録音中</span>
            )}
            {armed === "bass" && state === "recording" && (
              <span className="ml-2 text-rose-500">
                ● ベース層に録音中 (低音シンセ)
              </span>
            )}
            {armed === "synth" && state === "recording" && (
              <span className="ml-2 text-rose-500">● シンセ層に録音中</span>
            )}
            {armed === "guitar" && state === "recording" && (
              <span className="ml-2 text-rose-500">
                🎸 ギター層に録音中 (+{chordRecCount} コード)
              </span>
            )}
            {armed === "acoustic" && state === "recording" && (
              <span className="ml-2 text-rose-500">
                🎸 アコギ層に録音中 (+{chordRecCount} コード)
              </span>
            )}
            {armed === "vocal" && state === "recording" && (
              <span className="ml-2 text-rose-500">
                🎤 ボーカル層に録音中 (+{chordRecCount} コード)
              </span>
            )}
          </h2>
          {(spotlightLabel || selectedChord) && (
            <span className="text-xs font-medium text-accent-700">
              {spotlightLabel ??
                (selectedChord
                  ? `${chordSymbol(selectedChord)} ${chordLabelJa(selectedChord)}`
                  : "")}
            </span>
          )}
        </div>

        <SwipeCarousel
          panels={[
            {
              id: "chord-palette",
              title: "🎼 コードパレット",
              node: (
                <div className="px-1">
                  <ChordPalette
                    scale={scale}
                    onPlayChord={onPaletteChord}
                    onPlayPattern={onPaletteChordPattern}
                    armedLayer={armed}
                    activeIndex={activeChordIndex}
                  />
                  <p className="mt-3 text-xs text-ink-500">
                    タップでコードを鳴らせます。
                    armed が「コード」なら録音もできます。
                  </p>
                </div>
              ),
            },
            {
              id: "scale-piano",
              title: "🎵 スケールミニピアノ",
              node: (
                <div className="px-1">
                  <ChordTonePiano
                    scale={scale}
                    chord={selectedChord}
                    activeNotes={
                      playbackHighlight.size > 0
                        ? playbackHighlight
                        : activeNotes
                    }
                    onNoteOn={(m) => void handleNoteOn(m)}
                    onNoteOff={handleNoteOff}
                  />
                  <p className="mt-3 text-xs text-ink-500">
                    選んだスケールの音だけが並ぶので、どのキーを弾いてもキーから外れません。
                    コードパレットでコードを選ぶとそのコードトーン (★) が強調されます。
                  </p>
                </div>
              ),
            },
            {
              id: "full-piano",
              title: "🎹 88鍵ピアノ (自由)",
              node: (
                <div className="px-1">
                  <Piano
                    scale={scale}
                    activeNotes={
                      playbackHighlight.size > 0
                        ? playbackHighlight
                        : activeNotes
                    }
                    onNoteOn={(m) => void handleNoteOn(m)}
                    onNoteOff={handleNoteOff}
                  />
                  <p className="mt-3 text-xs text-ink-500">
                    横にスワイプ/スクロールで音域を移動。複数の指/PCキーボードで和音も弾けます。
                  </p>
                </div>
              ),
            },
          ]}
        />
      </section>

      {/* ⑥ 進行プリセット */}
      <section
        className={[
          "rounded-2xl border bg-orange-100 p-4 shadow-sm transition",
          armed === "chord"
            ? "border-accent-300"
            : "border-ink-200",
        ].join(" ")}
      >
        <h2 className="mb-3 text-sm font-semibold text-ink-700">
          ⑥ コード進行プリセット {armed === "chord" && "🎼 コード層に録音可"}
        </h2>
        <ProgressionList
          scale={scale}
          bpm={bpm}
          onPlayChord={onProgressionChord}
          onProgressionEnd={onProgressionEnd}
        />
        <p className="mt-3 text-xs text-ink-500">
          BPM <b className="font-mono">{bpm}</b> 連動: 1 コード = 1 小節 (
          {progressionGapSec.toFixed(2)} 秒)。ドラム②の BPM を変えると進行も追従します。
        </p>
      </section>

      {/* ⑦ 保存ゾーン (画面の一番下) */}
      <section className="rounded-2xl border border-violet-200 bg-gradient-to-r from-violet-50 via-fuchsia-50 to-violet-50 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-700">
              💾 保存・ライブラリ
            </h2>
            <p className="mt-1 text-xs text-ink-500">
              現在の譜面 (BPM・スケール・6 レイヤー) は自動的に別タブの保存ライブラリと同期しています。
              スロットへの保存・読み込み・別タブ再生はライブラリで行えます。
            </p>
          </div>
          <button
            type="button"
            onClick={openLibraryTab}
            className="rounded-full bg-violet-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-violet-700"
          >
            📂 保存ライブラリを別タブで開く
          </button>
        </div>
      </section>
    </div>
  );
}
