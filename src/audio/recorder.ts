/**
 * 2 レイヤー(メロディ + コード)録音 + 再生 + MIDI 書き出し。
 *
 * - 録音中は `noteOn(midi, velocity)` / `noteOff(midi)` を呼ぶだけ。
 * - 各 Layer はモノラル(時間順) のノートイベント列。重なり OK。
 * - 再生は Web Audio タイマで scheduling し、各ノートを Tone.js Sampler で鳴らす。
 * - MIDI 書き出しは @tonejs/midi で SMF (Standard MIDI File) を生成し Blob を返す。
 */

import { Midi } from "@tonejs/midi";
import { holdOff, holdOn } from "./pianoEngine";
import { triggerDrumHit } from "./drums";
import { bassHoldOff, bassHoldOn } from "./bassEngine";
import { synthHoldOff, synthHoldOn } from "./synthEngine";
import { guitarHoldOff, guitarHoldOn } from "./guitarEngine";

export type LayerId = "melody" | "chord" | "drum" | "bass" | "synth" | "guitar";

export interface NoteEvent {
  midi: number;
  /** 録音開始からのオフセット (秒) */
  startSec: number;
  /** ノート長 (秒) */
  durationSec: number;
  /** 0..1 */
  velocity: number;
}

export interface Layer {
  id: LayerId;
  name: string;
  notes: NoteEvent[];
}

export function emptyLayer(id: LayerId, name: string): Layer {
  return { id, name, notes: [] };
}

/**
 * 録音セッション。`begin()` で時刻 0 を確定し、
 * `noteOn` / `noteOff` を呼ぶと Layer に追加する。
 */
export class RecordingSession {
  private startedAt: number | null = null;
  private active = new Map<number, { startSec: number; velocity: number }>();
  private layer: Layer;
  constructor(layer: Layer) {
    this.layer = layer;
  }

  begin() {
    this.startedAt = performance.now();
    this.active.clear();
    this.layer.notes = [];
  }

  isRecording() {
    return this.startedAt !== null;
  }

  elapsedSec(): number {
    if (this.startedAt === null) return 0;
    return (performance.now() - this.startedAt) / 1000;
  }

  noteOn(midi: number, velocity = 0.85) {
    if (this.startedAt === null) return;
    if (this.active.has(midi)) return;
    this.active.set(midi, { startSec: this.elapsedSec(), velocity });
  }

  noteOff(midi: number) {
    if (this.startedAt === null) return;
    const a = this.active.get(midi);
    if (!a) return;
    this.active.delete(midi);
    const end = this.elapsedSec();
    this.layer.notes.push({
      midi,
      startSec: a.startSec,
      durationSec: Math.max(0.05, end - a.startSec),
      velocity: a.velocity,
    });
  }

  /**
   * 既知の長さのコード(ブロック)を一括で記録する。
   * パレットや進行プリセットのワンタップ用。
   *
   * `snapUnitSec` を指定すると、開始位置をその単位 (秒) にスナップする。
   * ドラム録音時にピアノロール上の拍グリッドと正確に重ねるために使う。
   */
  recordChord(
    midiNotes: number[],
    durationSec: number,
    velocity = 0.85,
    snapUnitSec?: number,
  ) {
    if (this.startedAt === null) return;
    let startSec = this.elapsedSec();
    if (snapUnitSec && snapUnitSec > 0) {
      startSec = Math.max(0, Math.round(startSec / snapUnitSec) * snapUnitSec);
    }
    const dur = Math.max(0.05, durationSec);
    for (const m of midiNotes) {
      this.layer.notes.push({
        midi: m,
        startSec,
        durationSec: dur,
        velocity,
      });
    }
  }

  /**
   * 録音中の最新ノート列のスナップショットを返す (PianoRoll リアルタイム描画用)。
   * - 確定ノートに加えて、まだリリースされていない持続音 (active) も
   *   `現在時刻まで伸びた仮ノート` として含める。
   * - 既存配列は返さず必ずコピーを返すので、これを React state に流しても
   *   レコーダ側の追記とぶつからない。
   */
  snapshotNotes(): NoteEvent[] {
    const out = [...this.layer.notes];
    if (this.startedAt === null) return out;
    const now = this.elapsedSec();
    this.active.forEach((a, midi) => {
      out.push({
        midi,
        startSec: a.startSec,
        durationSec: Math.max(0.02, now - a.startSec),
        velocity: a.velocity,
      });
    });
    return out;
  }

  /** 録音停止。残った押しっぱなしは即終了。 */
  end(): Layer {
    if (this.startedAt === null) return this.layer;
    const end = this.elapsedSec();
    this.active.forEach((a, midi) => {
      this.layer.notes.push({
        midi,
        startSec: a.startSec,
        durationSec: Math.max(0.05, end - a.startSec),
        velocity: a.velocity,
      });
    });
    this.active.clear();
    this.startedAt = null;
    this.layer.notes.sort((a, b) => a.startSec - b.startSec);
    return this.layer;
  }
}

/**
 * クオンタイズ粒度。
 * - "off": 何もしない (素のタイミング)
 * - "1/4" 〜 "1/32": BPM 基準で各拍/裏拍にスナップ
 */
export type QuantizeGrid = "off" | "1/4" | "1/8" | "1/16" | "1/32";

/** クオンタイズ粒度 1 単位の長さ (秒)。BPM 基準 (4 分音符 = 60/bpm 秒)。 */
export function quantizeUnitSec(grid: QuantizeGrid, bpm: number): number {
  const beatSec = 60 / Math.max(1, bpm);
  switch (grid) {
    case "1/4":
      return beatSec;
    case "1/8":
      return beatSec / 2;
    case "1/16":
      return beatSec / 4;
    case "1/32":
      return beatSec / 8;
    default:
      return 0;
  }
}

/**
 * Layer 内の各ノートの startSec をグリッドにスナップする。
 * - durationSec はそのまま (位置のみ揃える)
 * - "off" の場合は元の Layer をそのまま返す
 *
 * 例: 7.04 秒の chord と 6.97 秒の drum を 1/16 (BPM=120 → 0.125s) でスナップ
 *      → 両方 7.0 秒に揃って同時に鳴る
 */
export function quantizeLayer(
  layer: Layer,
  grid: QuantizeGrid,
  bpm: number,
): Layer {
  const unit = quantizeUnitSec(grid, bpm);
  if (unit <= 0) return layer;
  const notes = layer.notes
    .map((n) => ({
      ...n,
      startSec: Math.max(0, Math.round(n.startSec / unit) * unit),
    }))
    .sort((a, b) => a.startSec - b.startSec);
  return { ...layer, notes };
}

/** Layer の最終位置 (秒) */
export function layerDuration(layer: Layer): number {
  let max = 0;
  for (const n of layer.notes) {
    const e = n.startSec + n.durationSec;
    if (e > max) max = e;
  }
  return max;
}

/**
 * 複数レイヤーを同時再生する。
 * - スケジューリングは setTimeout ベース。Tone.js の trigger 自体は内部で精密。
 * - noteOn/noteOff コールバックでハイライト連動が可能。
 */
interface PlaybackHooks {
  onNoteOn?: (layerId: LayerId, midi: number) => void;
  onNoteOff?: (layerId: LayerId, midi: number) => void;
  onEnd?: () => void;
}

export class Playback {
  private timers: number[] = [];
  private playing = false;
  private startedAt = 0;
  private layers: Layer[];
  private hooks?: PlaybackHooks;

  constructor(layers: Layer[], hooks?: PlaybackHooks) {
    this.layers = layers;
    this.hooks = hooks;
  }

  isPlaying() {
    return this.playing;
  }

  /**
   * 再生を開始する。
   * `offsetSec` を指定すると、その秒数からの途中再生になる。
   * - offsetSec より前に終わるノートはスキップ
   * - offsetSec の途中にあるノートは「残り時間ぶん」だけ鳴らす (即時 noteOn)
   * - elapsedSec() は `offset + 経過時間` を返す (再生ヘッド連動)
   */
  start(offsetSec = 0) {
    this.stop();
    this.playing = true;
    const off = Math.max(0, offsetSec);
    // performance.now() を offset ぶん過去に擬似的にずらすことで
    // elapsedSec() がそのまま `offset + 経過` を返す
    this.startedAt = performance.now() - off * 1000;

    let last = 0;
    for (const layer of this.layers) {
      for (const note of layer.notes) {
        const noteEnd = note.startSec + note.durationSec;
        if (layer.id === "drum") {
          // ドラムは一発もの。offset 後のヒットだけスケジュールする。
          if (note.startSec < off - 1e-6) continue;
          const delayMs = (note.startSec - off) * 1000;
          const tOn = window.setTimeout(() => {
            triggerDrumHit(note.midi, undefined, note.velocity);
            this.hooks?.onNoteOn?.(layer.id, note.midi);
            window.setTimeout(
              () => this.hooks?.onNoteOff?.(layer.id, note.midi),
              120,
            );
          }, delayMs);
          this.timers.push(tOn);
          const end = note.startSec + 0.15;
          if (end > last) last = end;
          continue;
        }
        // 持続音: offset より完全に前なら無視
        if (noteEnd <= off + 1e-6) continue;
        const isBass = layer.id === "bass";
        const isSynth = layer.id === "synth";
        const isGuitar = layer.id === "guitar";
        // offset 区間にまたがるノートは即時 noteOn (delay=0)
        const startDelayMs = Math.max(0, (note.startSec - off) * 1000);
        const offDelayMs = Math.max(20, (noteEnd - off) * 1000);
        const tOn = window.setTimeout(() => {
          if (isBass) bassHoldOn(note.midi, note.velocity);
          else if (isSynth) synthHoldOn(note.midi, note.velocity);
          else if (isGuitar) guitarHoldOn(note.midi, note.velocity);
          else holdOn(note.midi, note.velocity);
          this.hooks?.onNoteOn?.(layer.id, note.midi);
        }, startDelayMs);
        const tOff = window.setTimeout(() => {
          if (isBass) bassHoldOff(note.midi);
          else if (isSynth) synthHoldOff(note.midi);
          else if (isGuitar) guitarHoldOff(note.midi);
          else holdOff(note.midi);
          this.hooks?.onNoteOff?.(layer.id, note.midi);
        }, offDelayMs);
        this.timers.push(tOn, tOff);
        if (noteEnd > last) last = noteEnd;
      }
    }
    const endDelayMs = Math.max(80, (last - off) * 1000 + 80);
    const tEnd = window.setTimeout(() => {
      this.playing = false;
      this.hooks?.onEnd?.();
    }, endDelayMs);
    this.timers.push(tEnd);
  }

  stop() {
    if (this.timers.length === 0 && !this.playing) return;
    this.timers.forEach((t) => window.clearTimeout(t));
    this.timers = [];
    this.playing = false;
  }

  elapsedSec(): number {
    if (!this.playing) return 0;
    return (performance.now() - this.startedAt) / 1000;
  }
}

/**
 * MIDI ファイル書き出し。テンポは 120 BPM (= 1秒 = 0.5小節) として記録。
 */
export function exportToMidi(layers: Layer[], filename: string): Blob {
  const midi = new Midi();
  midi.header.setTempo(120);
  for (const layer of layers) {
    const track = midi.addTrack();
    track.name = layer.name;
    if (layer.id === "drum") {
      // GM 規格のドラムチャンネル (0-indexed の 9 = 1-indexed の 10)
      track.channel = 9;
    }
    for (const n of layer.notes) {
      track.addNote({
        midi: n.midi,
        time: n.startSec,
        duration: Math.max(0.05, n.durationSec),
        velocity: Math.max(0.05, Math.min(1, n.velocity)),
      });
    }
  }
  const bytes = midi.toArray();
  return new Blob([new Uint8Array(bytes)], {
    type: "audio/midi",
    endings: "transparent",
  });
  void filename;
}

/** Blob をダウンロードする。 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
