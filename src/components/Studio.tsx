/**
 * Studio (統合スタジオ画面)。
 *
 * 演奏モードと録音モードを統合したワンスクリーン UI。
 *
 * 構成:
 *   ① キー / スケール
 *   ② ドラムマシン (5 パターン + BPM)
 *   ③ ピアノロール (DAW 風 / 録音した内容を可視化)
 *   ④ 録音トラック (メロディ層 / コード層)
 *   ⑤ コードパレット
 *   ⑥ 進行プリセット
 *   ⑦ スケール構成音だけのミニピアノ
 *   ⑧ 88 鍵ピアノ
 *
 * - 録音しなければ「演奏モード」として使えるし、
 *   そのまま録音ボタンを押せば「録音モード」として MIDI 書き出しまでできる。
 * - DAW 風オーバーダブ: 録音中は反対側の層を同時再生。
 * - 入力: ピアノ(タッチ/マウス) + PC キーボード + Web MIDI + コードパレット + 進行プリセット
 *
 * 重要: 録音状態とアーム対象は `stateRef` / `armedRef` 経由で常に最新値で判定する
 * (stale closure 防止)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  bassHoldOff,
  bassHoldOn,
  bassReleaseAll,
} from "../audio/bassEngine";
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
}

export default function Studio({ scale, onScaleChange }: StudioProps) {
  const [melody, setMelody] = useState<Layer>(() => emptyLayer("melody", "メロディ"));
  const [chord, setChord] = useState<Layer>(() => emptyLayer("chord", "コード"));
  const [drum, setDrum] = useState<Layer>(() => emptyLayer("drum", "ドラム"));
  const [bass, setBass] = useState<Layer>(() => emptyLayer("bass", "ベース"));
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
  const refreshScheduledRef = useRef(false);
  const scheduleRefresh = useCallback(() => {
    if (refreshScheduledRef.current) return;
    refreshScheduledRef.current = true;
    requestAnimationFrame(() => {
      refreshScheduledRef.current = false;
      if (armedRef.current === "melody") {
        setMelody((cur) => ({ ...cur, notes: [...cur.notes] }));
      } else if (armedRef.current === "chord") {
        setChord((cur) => ({ ...cur, notes: [...cur.notes] }));
      } else if (armedRef.current === "bass") {
        setBass((cur) => ({ ...cur, notes: [...cur.notes] }));
      } else {
        setDrum((cur) => ({ ...cur, notes: [...cur.notes] }));
      }
    });
  }, []);

  // ---- Undo/Redo: 破壊的操作の前にスナップショット保存 -----------------------
  const pushHistory = useCallback(() => {
    setPast((p) => {
      const snap: Snapshot = { melody, chord, drum, bass };
      const next = [...p, snap];
      if (next.length > HISTORY_LIMIT) next.shift();
      return next;
    });
    setFuture([]);
  }, [melody, chord, drum, bass]);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [...f, { melody, chord, drum, bass }]);
      setMelody(prev.melody);
      setChord(prev.chord);
      setDrum(prev.drum);
      setBass(prev.bass);
      return p.slice(0, -1);
    });
  }, [melody, chord, drum, bass]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1];
      setPast((p) => [...p, { melody, chord, drum, bass }]);
      setMelody(next.melody);
      setChord(next.chord);
      setDrum(next.drum);
      setBass(next.bass);
      return f.slice(0, -1);
    });
  }, [melody, chord, drum, bass]);

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
  const handleDrumHit = useCallback(
    (midi: number, velocity: number) => {
      if (
        stateRef.current === "recording" &&
        armedRef.current === "drum" &&
        sessionRef.current
      ) {
        // ドラムは percussive: 短い固定 duration で 1 ヒットを記録
        sessionRef.current.recordChord([midi], 0.05, velocity);
        setDrumRecCount((n) => n + 1);
        scheduleRefresh();
      }
    },
    [scheduleRefresh],
  );

  // ---- audio gate -----------------------------------------------------------
  const arm = useCallback(async () => {
    if (audioReady.current) return;
    await ensureAudio();
    audioReady.current = true;
  }, []);

  // ---- 共通 note handler (ピアノ/キーボード/MIDI) ---------------------------
  // bass がアームされているときは bassEngine、それ以外は pianoEngine に流す
  const handleNoteOn = useCallback(
    async (midi: number, velocity = 0.85) => {
      await arm();
      if (armedRef.current === "bass") {
        bassHoldOn(midi, velocity);
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
      }
    },
    [arm],
  );

  const handleNoteOff = useCallback(
    (midi: number) => {
      // 入力中に armed が切り替わっている可能性に備えて両方 off する
      holdOff(midi);
      bassHoldOff(midi);
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
  const onPaletteChord = useCallback(
    async (c: HarmonicChord, midiNotes: number[]) => {
      await arm();
      chordOn(midiNotes, 0.8, PALETTE_CHORD_DURATION_SEC);
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

      // コード層を録音中ならコードイベントとして記録
      if (
        stateRef.current === "recording" &&
        armedRef.current === "chord" &&
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
        chordOn(midiNotes, 0.8, durationSec);
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
          armedRef.current === "chord" &&
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
            : drum;
    const fresh = emptyLayer(armed, layer.name);
    if (armed === "melody") setMelody(fresh);
    else if (armed === "chord") setChord(fresh);
    else if (armed === "bass") setBass(fresh);
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
    });
    setActiveNotes(new Set());
    setPlaybackHighlight(new Set());
  }

  function clearLayer(id: LayerId) {
    pushHistory();
    if (id === "melody") setMelody(emptyLayer("melody", "メロディ"));
    else if (id === "chord") setChord(emptyLayer("chord", "コード"));
    else if (id === "bass") setBass(emptyLayer("bass", "ベース"));
    else setDrum(emptyLayer("drum", "ドラム"));
  }

  // ---- 再生 -----------------------------------------------------------------
  async function startPlayback() {
    await arm();
    if (state === "recording") stopRecord();
    cancelProgressionTimers();
    // 録音した内容を再生する間はライブ DrumLoop を止める (二重発音防止)
    if (drumPadRef.current?.isPlaying()) drumPadRef.current.stop();
    const layers = [melody, chord, bass, drum].filter((l) => l.notes.length > 0);
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
  }

  function exportMidi() {
    const layers = [melody, chord, bass, drum].filter((l) => l.notes.length > 0);
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
    setActiveNotes(new Set());
    setPlaybackHighlight(new Set());
    setActiveChordIndex(null);
    setSpotlightLabel(null);
  }

  // ---- 手動編集ハンドラ -----------------------------------------------------
  // PianoRoll から「クリックでノート追加」「クリックでノート削除」を受け取る
  const handleAddNote = useCallback(
    (layerId: LayerId, midi: number, startSec: number) => {
      pushHistory();
      const dur = layerId === "drum" ? 0.05 : 0.5;
      const note = { midi, startSec, durationSec: dur, velocity: 0.85 };
      const update = (cur: Layer): Layer => ({
        ...cur,
        notes: [...cur.notes, note].sort((a, b) => a.startSec - b.startSec),
      });
      if (layerId === "melody") setMelody(update);
      else if (layerId === "chord") setChord(update);
      else if (layerId === "bass") setBass(update);
      else setDrum(update);
    },
    [pushHistory],
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
      else setDrum(update);
    },
    [pushHistory],
  );

  // ---- アンマウント時クリーンアップ ----------------------------------------
  useEffect(() => {
    return () => {
      if (playbackRef.current) playbackRef.current.stop();
      if (overdubRef.current) overdubRef.current.stop();
      cancelProgressionTimers();
      releaseAll();
      bassReleaseAll();
    };
  }, []);

  // ---- UI -------------------------------------------------------------------
  const melodyDur = useMemo(() => layerDuration(melody), [melody]);
  const chordDur = useMemo(() => layerDuration(chord), [chord]);
  const drumDur = useMemo(() => layerDuration(drum), [drum]);
  const bassDur = useMemo(() => layerDuration(bass), [bass]);
  const totalDur = Math.max(melodyDur, chordDur, drumDur, bassDur);
  const hasAnything =
    melody.notes.length > 0 ||
    chord.notes.length > 0 ||
    drum.notes.length > 0 ||
    bass.notes.length > 0;
  const overdubPlaying =
    state === "recording" &&
    ((armed !== "melody" && melody.notes.length > 0) ||
      (armed !== "chord" && chord.notes.length > 0) ||
      (armed !== "bass" && bass.notes.length > 0) ||
      (armed !== "drum" && drum.notes.length > 0));
  const isActive = state === "recording" || playing;
  const recordingLayerId: LayerId | null =
    state === "recording" ? armed : null;
  const trackInfo: { id: LayerId; layer: Layer; label: string }[] = [
    { id: "melody", layer: melody, label: "🎵 メロディ層" },
    { id: "chord", layer: chord, label: "🎼 コード層" },
    { id: "bass", layer: bass, label: "🎸 ベース層" },
    { id: "drum", layer: drum, label: "🥁 ドラム層" },
  ];
  const armedLabel =
    armed === "melody"
      ? "メロディ"
      : armed === "chord"
        ? "コード"
        : armed === "bass"
          ? "ベース"
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

      {/* ③ ピアノロール */}
      <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-700">
            ③ ピアノロール (DAW 風 / ドラムレーン付き)
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
              title={`編集モード ON のときは、ピアノロール上をクリックしてノートを追加 / 既存ノートをクリックして削除できます。${armedLabel}層が編集対象です。`}
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
            ✎ 編集モード: 空の場所をクリックすると <b>{armedLabel}層</b> にノート追加 (0.5 秒、ドラムは 1 ヒット)。
            既存ノートをクリックすると削除できます。下の④で対象トラックを切り替えられます。
          </div>
        )}
        <PianoRoll
          melody={melody}
          chord={chord}
          drum={drum}
          bass={bass}
          isActive={isActive}
          recordingLayerId={recordingLayerId}
          getPlayheadSec={getPlayheadSec}
          bpm={bpm}
          editMode={editMode}
          armedLayer={armed}
          onAddNote={handleAddNote}
          onDeleteNote={handleDeleteNote}
        />
      </section>

      {/* ④ 録音トラック */}
      <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-700">
            ④ 録音トラック (録音したい時だけ使う)
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          ドラム層を録音中はドラムループも自動で回ります。
        </p>
      </section>

      {/* ⑤ コードパレット */}
      <section
        className={[
          "rounded-2xl border bg-white p-4 shadow-sm transition",
          armed === "chord"
            ? "border-accent-300"
            : "border-ink-200",
        ].join(" ")}
      >
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-700">
            ⑤ コードパレット{" "}
            {armed === "chord" && state === "recording"
              ? `🎼 録音中 (+${chordRecCount} コード)`
              : armed === "chord"
                ? "🎼 コード層に録音可"
                : ""}
          </h2>
          {spotlightLabel && (
            <span className="text-xs font-medium text-accent-700">
              {spotlightLabel}
            </span>
          )}
        </div>
        <ChordPalette
          scale={scale}
          onPlayChord={onPaletteChord}
          activeIndex={activeChordIndex}
        />
        <p className="mt-3 text-xs text-ink-500">
          タップでコードを鳴らせます。下のピアノに構成音が光ります。
        </p>
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

      {/* ⑦ スケール構成音だけのミニピアノ */}
      <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-700">
            ⑦ スケール構成音だけのミニピアノ (キーから外れない)
            {armed === "melody" && state === "recording" && (
              <span className="ml-2 text-rose-500">● メロディ層に録音中</span>
            )}
            {armed === "bass" && state === "recording" && (
              <span className="ml-2 text-rose-500">● ベース層に録音中 (低音シンセ)</span>
            )}
            {armed === "bass" && state !== "recording" && (
              <span className="ml-2 text-emerald-600">🎸 ベース音で鳴ります</span>
            )}
          </h2>
          {selectedChord && (
            <span className="text-xs font-medium text-accent-700">
              {chordSymbol(selectedChord)} {chordLabelJa(selectedChord)}
            </span>
          )}
        </div>
        <ChordTonePiano
          scale={scale}
          chord={selectedChord}
          activeNotes={
            playbackHighlight.size > 0 ? playbackHighlight : activeNotes
          }
          onNoteOn={(m) => void handleNoteOn(m)}
          onNoteOff={handleNoteOff}
        />
        <p className="mt-3 text-xs text-ink-500">
          選んだスケールの音だけが並ぶので、どのキーを弾いてもキーから外れません。
          ⑤でコードを選ぶとそのコードトーン (★) が強調され、最も安全な着地音が分かります。
        </p>
      </section>

      {/* ⑧ ピアノ */}
      <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-ink-700">
          ⑧ ピアノで自由に弾く (88鍵 / 複数同時押しOK)
        </h2>
        <Piano
          scale={scale}
          activeNotes={
            playbackHighlight.size > 0 ? playbackHighlight : activeNotes
          }
          onNoteOn={(m) => void handleNoteOn(m)}
          onNoteOff={handleNoteOff}
        />
        <p className="mt-3 text-xs text-ink-500">
          横にスワイプ/スクロールで音域を移動できます。指やマウスを滑らせるとグリッサンド、
          複数の指/PCキーボードで和音も弾けます。
        </p>
      </section>
    </div>
  );
}
