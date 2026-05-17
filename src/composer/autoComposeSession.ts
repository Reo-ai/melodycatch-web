/**
 * 自動作曲の「リアルタイム書き込み + 発音」スケジューラ。
 *
 * - composeSong で生成済みの ComposedSong を受け取り、
 *   各ノートの startSec に到達した瞬間に
 *     1) onAddNote コールバックで PianoRoll にノートを追加し
 *     2) 該当の音源エンジンを noteOn → noteOff で鳴らす
 *   ことで、ユーザーは「AI がリアルタイムで音を打ち込んでいる」様子を
 *   見たり聞いたりできる。
 *
 * - speedMultiplier=1.0 で実時間進行 (= 普通の再生と同じ速さで書き込まれる)。
 *   2.0 / 4.0 にすると早回しで打ち込みだけアニメーションする。
 */

import type { LayerId, NoteEvent } from "../audio/recorder";
import {
  holdOff as pianoHoldOff,
  holdOn as pianoHoldOn,
} from "../audio/pianoEngine";
import { triggerDrumHit } from "../audio/drums";
import { triggerDrumHitAcoustic } from "../audio/drumsAcoustic";
import { triggerFx } from "../audio/fxEngine";
import { bassHoldOff, bassHoldOn } from "../audio/bassEngine";
import { synthHoldOff, synthHoldOn } from "../audio/synthEngine";
import { guitarHoldOff, guitarHoldOn } from "../audio/guitarEngine";
import { acousticHoldOff, acousticHoldOn } from "../audio/acousticGuitarEngine";
import { vocalHoldOff, vocalHoldOn } from "../audio/vocalEngine";
import type { ComposedSong } from "./autoComposer";

export interface AutoComposeCallbacks {
  /** ノートを 1 つ書き込むときに呼ばれる。React 側で setState する。 */
  onAddNote: (layerId: LayerId, note: NoteEvent) => void;
  /** 進捗 (0..1) と現在小節 (1-indexed) の通知。UI のプログレスバー用。 */
  onProgress?: (progress: number, currentBar: number) => void;
  /** 全ノート書き込み + 発音完了。 */
  onComplete?: () => void;
}

interface ScheduledItem {
  layerId: LayerId;
  note: NoteEvent;
}

function holdOnFor(
  layerId: LayerId,
  midi: number,
  velocity: number,
  durationSec = 0.25,
): void {
  switch (layerId) {
    case "bass":
      bassHoldOn(midi, velocity);
      return;
    case "synth":
      synthHoldOn(midi, velocity);
      return;
    case "guitar":
      guitarHoldOn(midi, velocity);
      return;
    case "acoustic":
      acousticHoldOn(midi, velocity);
      return;
    case "vocal":
      vocalHoldOn(midi, velocity);
      return;
    case "drum":
      triggerDrumHit(midi, undefined, velocity);
      return;
    case "drumAcoustic":
      triggerDrumHitAcoustic(midi, undefined, velocity);
      return;
    case "fx":
      triggerFx(midi, durationSec, velocity);
      return;
    default:
      pianoHoldOn(midi, velocity);
  }
}

function holdOffFor(layerId: LayerId, midi: number): void {
  switch (layerId) {
    case "bass":
      bassHoldOff(midi);
      return;
    case "synth":
      synthHoldOff(midi);
      return;
    case "guitar":
      guitarHoldOff(midi);
      return;
    case "acoustic":
      acousticHoldOff(midi);
      return;
    case "vocal":
      vocalHoldOff(midi);
      return;
    case "drum":
      // ドラムは一発もの (triggerDrumHit) なので Off は不要
      return;
    case "drumAcoustic":
      // 生ドラムも一発ものなので Off は不要
      return;
    default:
      pianoHoldOff(midi);
  }
}

export class AutoComposeSession {
  private timers: number[] = [];
  private running = false;
  private startedAt = 0;
  private speed = 1.0;
  private items: ScheduledItem[] = [];
  private callbacks: AutoComposeCallbacks;
  private song: ComposedSong;
  private barSec: number;
  private progressTimer: number | null = null;

  constructor(
    song: ComposedSong,
    callbacks: AutoComposeCallbacks,
    extraStreams: { layerId: LayerId; notes: NoteEvent[] }[] = [],
  ) {
    this.song = song;
    this.callbacks = callbacks;
    this.barSec = (60 / song.bpm) * 4;
    const baseItems: ScheduledItem[] = [
      ...song.melodyNotes.map((n) => ({ layerId: "melody" as LayerId, note: n })),
      ...song.chordNotes.map((n) => ({ layerId: "chord" as LayerId, note: n })),
      ...song.bassNotes.map((n) => ({ layerId: "bass" as LayerId, note: n })),
      ...song.drumNotes.map((n) => ({ layerId: "drum" as LayerId, note: n })),
      ...song.fxNotes.map((n) => ({ layerId: "fx" as LayerId, note: n })),
    ];
    const extraItems: ScheduledItem[] = extraStreams.flatMap((s) =>
      s.notes.map((n) => ({ layerId: s.layerId, note: n })),
    );
    this.items = [...baseItems, ...extraItems].sort(
      (a, b) => a.note.startSec - b.note.startSec,
    );
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * @param speed 1.0=実時間, 2.0=2倍速, 4.0=4倍速。
   *              発音タイミングと書き込みタイミングが speed で割られる。
   */
  start(speed = 1.0): void {
    this.stop();
    this.running = true;
    this.speed = Math.max(0.25, speed);
    this.startedAt = performance.now();

    for (const item of this.items) {
      const delayMs = (item.note.startSec * 1000) / this.speed;
      const tOn = window.setTimeout(() => {
        // ノートを PianoRoll に追加
        this.callbacks.onAddNote(item.layerId, item.note);
        // 同時に発音 (オーディオは speed をかけて短縮しない: 普通に弾く)
        holdOnFor(
          item.layerId,
          item.note.midi,
          item.note.velocity,
          item.note.durationSec,
        );
      }, delayMs);
      this.timers.push(tOn);

      // ドラム / 生ドラム / FX は一発もの (noteOff 不要)
      if (
        item.layerId !== "drum" &&
        item.layerId !== "drumAcoustic" &&
        item.layerId !== "fx"
      ) {
        // オーディオの長さは「実時間に近い感じ」を優先するため
        // 表記の durationSec をそのまま使う (speed には依存しない)。
        // ただし speed が大きい場合に音が被って詰まるのを避けるため、
        // durationSec / speed で短縮する。
        const audioDurSec = Math.max(
          0.08,
          Math.min(item.note.durationSec, item.note.durationSec / this.speed + 0.05),
        );
        const tOff = window.setTimeout(
          () => {
            holdOffFor(item.layerId, item.note.midi);
          },
          delayMs + audioDurSec * 1000,
        );
        this.timers.push(tOff);
      }
    }

    // 進捗通知 (200ms 間隔)
    if (this.callbacks.onProgress) {
      const tickProgress = () => {
        if (!this.running) return;
        const elapsed = (performance.now() - this.startedAt) / 1000;
        const songElapsed = elapsed * this.speed;
        const progress = Math.min(1, songElapsed / Math.max(0.01, this.song.totalSec));
        const currentBar = Math.min(
          this.song.chords.length,
          Math.floor(songElapsed / this.barSec) + 1,
        );
        this.callbacks.onProgress?.(progress, currentBar);
      };
      this.progressTimer = window.setInterval(tickProgress, 200) as unknown as number;
      tickProgress();
    }

    // 完了通知
    const totalDelayMs = (this.song.totalSec * 1000) / this.speed + 200;
    const tEnd = window.setTimeout(() => {
      this.running = false;
      if (this.progressTimer !== null) {
        window.clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      this.callbacks.onProgress?.(1, this.song.chords.length);
      this.callbacks.onComplete?.();
    }, totalDelayMs);
    this.timers.push(tEnd);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }
}
