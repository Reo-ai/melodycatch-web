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
import ChordPalette from "./ChordPalette";
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
  type QuantizeGrid,
} from "../audio/recorder";
import {
  chordOn,
  ensureAudio,
  holdOff,
  holdOn,
  releaseAll,
} from "../audio/pianoEngine";
import {
  bassChordOn,
  bassHoldOff,
  bassHoldOn,
  bassReleaseAll,
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
} from "../audio/guitarEngine";
import {
  setMetronomeBpm,
  startMetronome,
  stopMetronome,
} from "../audio/metronome";
import { useComputerKeyboard } from "../input/useComputerKeyboard";
import { useWebMIDI } from "../input/useWebMIDI";
import type { Scale } from "../music/scale";
import {
  chordLabelJa,
  chordSymbol,
  diatonicTriads,
  type HarmonicChord,
} from "../music/chord";

interface StudioProps {
  scale: Scale;
  onScaleChange: (s: Scale) => void;
}

type ArmState = "idle" | "recording";

const PALETTE_CHORD_DURATION_SEC = 1.4;
const HISTORY_LIMIT = 50;

interface Snapshot {
  melody: Layer;
  chord: Layer;
  drum: Layer;
  bass: Layer;
  synth: Layer;
  guitar: Layer;
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
  const [armed, setArmed] = useState<LayerId>("melody");
  const [state, setState] = useState<ArmState>("idle");
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());
  const [playbackHighlight, setPlaybackHighlight] = useState<Set<number>>(new Set());
  const [activeChordIndex, setActiveChordIndex] = useState<number | null>(null);
  const [spotlightLabel, setSpotlightLabel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [chordRecCount, setChordRecCount] = useState(0);
  const [drumRecCount, setDrumRecCount] = useState(0);
  const [selectedChord, setSelectedChord] = useState<HarmonicChord | null>(null);
  const [bpm, setBpm] = useState<number>(100);
  const [quantizeGrid, setQuantizeGrid] = useState<QuantizeGrid>("1/16");
  const [editMode, setEditMode] = useState(false);
  const [noteLength, setNoteLength] = useState<NoteLength>("1/8");
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const audioReady = useRef(false);

  const sessionRef = useRef<RecordingSession | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const overdubRef = useRef<Playback | null>(null);
  const tickRef = useRef<number | null>(null);
  const progressionTimersRef = useRef<number[]>([]);
  const drumPadRef = useRef<DrumPadHandle | null>(null);

  // ---- stale closure 対策: 常に最新の state/armed を参照する ref ---------
  const stateRef = useRef<ArmState>("idle");
  const armedRef = useRef<LayerId>("melody");
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);

  // スケール変更時はコード選択をリセット
  useEffect(() => {
    setSelectedChord(null);
    setActiveChordIndex(null);
    setSpotlightLabel(null);
  }, [scale.rootPitchClass, scale.kind]);

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
      const snap: Snapshot = { melody, chord, drum, bass, synth, guitar };
      const next = [...p, snap];
      if (next.length > HISTORY_LIMIT) next.shift();
      return next;
    });
    setFuture([]);
  }, [melody, chord, drum, bass, synth, guitar]);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [...f, { melody, chord, drum, bass, synth, guitar }]);
      setMelody(prev.melody);
      setChord(prev.chord);
      setDrum(prev.drum);
      setBass(prev.bass);
      setSynth(prev.synth);
      setGuitar(prev.guitar);
      return p.slice(0, -1);
    });
  }, [melody, chord, drum, bass, synth, guitar]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1];
      setPast((p) => [...p, { melody, chord, drum, bass, synth, guitar }]);
      setMelody(next.melody);
      setChord(next.chord);
      setDrum(next.drum);
      setBass(next.bass);
      setSynth(next.synth);
      setGuitar(next.guitar);
      return f.slice(0, -1);
    });
  }, [melody, chord, drum, bass, synth, guitar]);

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
      if (
        stateRef.current === "recording" &&
        armedRef.current === "drum" &&
        sessionRef.current
      ) {
        const beat = 60 / Math.max(1, bpm);
        const snap =
          quantizeGrid !== "off"
            ? quantizeUnitSec(quantizeGrid, bpm)
            : beat / 4; // 1/16 fallback
        // ドラムは percussive: 短い固定 duration で 1 ヒットを記録 + 拍にスナップ
        sessionRef.current.recordChord([midi], 0.05, velocity, snap);
        setDrumRecCount((n) => n + 1);
        scheduleRefresh();
      }
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

  // ---- コードパレット --------------------------------------------------------
  // armed されている楽器に合わせてコードを発音する。
  // - chord/melody/drum: ピアノ
  // - bass: ベース (ルートを 1oct 下げて重ねる)
  // - synth: シンセ
  // - guitar: ギター (ストロークっぽくずらして発音)
  // 録音は「コード層」または「ギター層」が armed のときに行う。
  const onPaletteChord = useCallback(
    async (c: HarmonicChord, midiNotes: number[]) => {
      await arm();
      const a = armedRef.current;
      if (a === "bass") bassChordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
      else if (a === "synth") synthChordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
      else if (a === "guitar") guitarChordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
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

      // コード層 / ギター層 を録音中なら記録
      if (
        stateRef.current === "recording" &&
        (armedRef.current === "chord" || armedRef.current === "guitar") &&
        sessionRef.current
      ) {
        sessionRef.current.recordChord(
          midiNotes,
          PALETTE_CHORD_DURATION_SEC,
          0.8,
        );
        setChordRecCount((n) => n + 1);
        scheduleRefresh();
      }
    },
    [arm, scale, scheduleRefresh],
  );

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
        if (
          stateRef.current === "recording" &&
          (armedRef.current === "chord" || armedRef.current === "guitar") &&
          sessionRef.current
        ) {
          sessionRef.current.recordChord(midiNotes, durationSec, 0.8);
          setChordRecCount((n) => n + 1);
          scheduleRefresh();
        }
      }, delayMs);
      progressionTimersRef.current.push(t);
    },
    [arm, scale, scheduleRefresh],
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

  // ---- PianoRoll の再生ヘッド用 getter -------------------------------------
  const getPlayheadSec = useCallback(() => {
    if (sessionRef.current && stateRef.current === "recording") {
      return sessionRef.current.elapsedSec();
    }
    if (playbackRef.current && playing) {
      return playbackRef.current.elapsedSec();
    }
    return 0;
  }, [playing]);

  // ---- 録音操作 -------------------------------------------------------------
  async function startRecord() {
    await arm();
    stopPlayback();
    cancelProgressionTimers();

    // 録音は対象レイヤを上書きするので Undo 用にスナップショット
    pushHistory();

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
                : drum;
    const fresh = emptyLayer(armed, layer.name);
    if (armed === "melody") setMelody(fresh);
    else if (armed === "chord") setChord(fresh);
    else if (armed === "bass") setBass(fresh);
    else if (armed === "synth") setSynth(fresh);
    else if (armed === "guitar") setGuitar(fresh);
    else setDrum(fresh);

    sessionRef.current = new RecordingSession(fresh);
    sessionRef.current.begin();
    setChordRecCount(0);
    setDrumRecCount(0);

    // DAW 風オーバーダブ: 録音対象以外の既存レイヤを同時再生
    const otherLayers: Layer[] = [];
    if (armed !== "melody" && melody.notes.length > 0) otherLayers.push(melody);
    if (armed !== "chord" && chord.notes.length > 0) otherLayers.push(chord);
    if (armed !== "bass" && bass.notes.length > 0) otherLayers.push(bass);
    if (armed !== "synth" && synth.notes.length > 0) otherLayers.push(synth);
    if (armed !== "guitar" && guitar.notes.length > 0) otherLayers.push(guitar);
    if (armed !== "drum" && drum.notes.length > 0) otherLayers.push(drum);
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

    // ドラム録音時は DrumLoop も自動で回し始める (鳴らした音がそのまま録音される)
    if (armed === "drum" && drumPadRef.current && !drumPadRef.current.isPlaying()) {
      await drumPadRef.current.start();
    }

    setState("recording");
  }

  function stopRecord() {
    if (sessionRef.current) {
      const finished = sessionRef.current.end();
      if (finished.id === "melody") setMelody({ ...finished });
      else if (finished.id === "chord") setChord({ ...finished });
      else if (finished.id === "bass") setBass({ ...finished });
      else if (finished.id === "synth") setSynth({ ...finished });
      else if (finished.id === "guitar") setGuitar({ ...finished });
      else setDrum({ ...finished });
    }
    sessionRef.current = null;
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
    else setDrum(emptyLayer("drum", "ドラム"));
  }

  // ---- 再生 -----------------------------------------------------------------
  async function startPlayback() {
    await arm();
    if (state === "recording") stopRecord();
    cancelProgressionTimers();
    // 録音した内容を再生する間はライブ DrumLoop を止める (二重発音防止)
    if (drumPadRef.current?.isPlaying()) drumPadRef.current.stop();
    const layers = [melody, chord, bass, synth, guitar, drum].filter(
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
    pb.start();
    setPlaying(true);
  }

  function stopPlayback() {
    if (playbackRef.current) playbackRef.current.stop();
    playbackRef.current = null;
    setPlaying(false);
    setPlaybackHighlight(new Set());
    releaseAll();
    bassReleaseAll();
    synthReleaseAll();
    guitarReleaseAll();
  }

  function cancelProgressionTimers() {
    progressionTimersRef.current.forEach((t) => window.clearTimeout(t));
    progressionTimersRef.current = [];
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
  }

  function exportMidi() {
    const layers = [melody, chord, bass, synth, guitar, drum].filter(
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
    cancelProgressionTimers();
    releaseAll();
    bassReleaseAll();
    synthReleaseAll();
    guitarReleaseAll();
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
  const totalDur = Math.max(
    melodyDur,
    chordDur,
    drumDur,
    bassDur,
    synthDur,
    guitarDur,
  );
  const hasAnything =
    melody.notes.length > 0 ||
    chord.notes.length > 0 ||
    drum.notes.length > 0 ||
    bass.notes.length > 0 ||
    synth.notes.length > 0 ||
    guitar.notes.length > 0;
  const overdubPlaying =
    state === "recording" &&
    ((armed !== "melody" && melody.notes.length > 0) ||
      (armed !== "chord" && chord.notes.length > 0) ||
      (armed !== "bass" && bass.notes.length > 0) ||
      (armed !== "synth" && synth.notes.length > 0) ||
      (armed !== "guitar" && guitar.notes.length > 0) ||
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
              : "ドラム";
  const progressionGapSec = (60 * 4) / Math.max(40, Math.min(220, bpm));

  return (
    <div className="flex flex-col gap-6">
      {/* ① キー / スケール */}
      <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
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
          "rounded-2xl border bg-white p-4 shadow-sm transition",
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

      {/* ③ 録音トラック (ピアノロールの上に配置: ピアノロールを見ながら録音できるように) */}
      <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
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

        <div className="mt-4 flex flex-wrap gap-2">
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

          {!playing ? (
            <button
              type="button"
              onClick={startPlayback}
              disabled={state === "recording" || !hasAnything}
              className="rounded-full bg-accent-500 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent-600 disabled:opacity-40"
            >
              ▶ 同時再生 (全層)
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

          <button
            type="button"
            onClick={exportMidi}
            disabled={!hasAnything}
            className="rounded-full border border-ink-300 bg-white px-5 py-2 text-sm font-semibold text-ink-700 shadow-sm hover:border-accent-300 disabled:opacity-40"
          >
            ⤓ MIDIファイル書き出し
          </button>
        </div>

        <p className="mt-3 text-xs text-ink-500">
          録音せずただ弾くだけでも OK。録音中は録音対象以外のレイヤが同時再生されます (DAW 風オーバーダブ)。
          ドラム層を録音中はドラムループも自動で回ります。下のピアノロールを見ながら録音できます。
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
              onClick={() => setEditMode((v) => !v)}
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
        {editMode && (
          <div className="mb-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
            ✎ 編集モード: 空の場所をドラッグで範囲選択 / クリックで <b>{armedLabel}層</b> にノート追加 (長さ <b>{noteLength}</b>、ドラムは 1 ヒット)。
            ノートをドラッグで自由に移動 (時間 + 音程)。両端を掴むと長さ調整 (範囲選択中は全ノートが同じ量だけ伸縮)。
            選択中に <b>Delete</b>/<b>Backspace</b> で一括削除、<b>Esc</b> で選択解除。
            移動・リサイズは小節グリッドへスナップ (右上のセレクタで分解能を変更)。
            <b>Cmd</b> / <b>Ctrl</b> を押しながら操作するとスナップを一時的に無効化。
          </div>
        )}
        <PianoRoll
          melody={melody}
          chord={chord}
          drum={drum}
          bass={bass}
          synth={synth}
          guitar={guitar}
          isActive={isActive}
          recordingLayerId={recordingLayerId}
          getPlayheadSec={getPlayheadSec}
          bpm={bpm}
          editMode={editMode}
          armedLayer={armed}
          onAddNote={handleAddNote}
          onDeleteNote={handleDeleteNote}
          onResizeNote={handleResizeNote}
          onResizeNotes={handleResizeNotes}
          onDeleteNotes={handleDeleteNotes}
          onMoveNotes={handleMoveNotes}
        />
      </section>

      {/* ⑤ 入力カルーセル: コードパレット → スケールミニピアノ → 88鍵ピアノ */}
      <section
        className={[
          "rounded-2xl border bg-white p-4 shadow-sm transition",
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
          "rounded-2xl border bg-white p-4 shadow-sm transition",
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
    </div>
  );
}
