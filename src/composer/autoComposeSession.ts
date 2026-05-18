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

/** look-ahead 用の note-off エントリ (song-time 基準)。 */
interface PendingOff {
  /** この時刻 (song-time 秒) を過ぎたら holdOff を呼ぶ */
  offSongSec: number;
  layerId: LayerId;
  midi: number;
}

export class AutoComposeSession {
  private running = false;
  private startedAt = 0;
  private speed = 1.0;
  private items: ScheduledItem[] = [];
  private callbacks: AutoComposeCallbacks;
  private song: ComposedSong;
  private barSec: number;
  /** 単一の look-ahead ティック (25ms 間隔)。 */
  private tickTimer: number | null = null;
  /** 進捗コールバックのスロットリング用。 */
  private lastProgressAt = 0;

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
   *
   * look-ahead 方式: 数千個の setTimeout を事前確保せず、
   * 25ms 周期のティックで「次に到達したノート」だけを順に fire する。
   * これでブラウザのタイマーキューに 1 個しか残らないため、
   * ノート数 1000+ でもスケジューラ起因のジッタ/重さがなくなる。
   */
  start(speed = 1.0): void {
    this.stop();
    this.running = true;
    this.speed = Math.max(0.25, speed);
    this.startedAt = performance.now();
    this.lastProgressAt = 0;

    // song-time 秒で記録される note-on / note-off 進行管理。
    let cursor = 0;
    const pendingOffs: PendingOff[] = [];
    const TICK_MS = 25;
    /** look-ahead (song-time 秒)。次ティック分を先取りして
     *  ティック境界による発音の遅れを 1 ティック以内に抑える。 */
    const LOOKAHEAD_SONG_SEC = (TICK_MS / 1000) * this.speed;

    const tick = () => {
      if (!this.running) return;
      const elapsedRealSec = (performance.now() - this.startedAt) / 1000;
      const songSec = elapsedRealSec * this.speed;
      const horizon = songSec + LOOKAHEAD_SONG_SEC;

      // 1) note-on を fire (cursor 以降で startSec <= horizon のもの)
      while (
        cursor < this.items.length &&
        this.items[cursor].note.startSec <= horizon
      ) {
        const item = this.items[cursor++];
        this.callbacks.onAddNote(item.layerId, item.note);
        holdOnFor(
          item.layerId,
          item.note.midi,
          item.note.velocity,
          item.note.durationSec,
        );
        // 持続系レイヤだけ note-off を pending に積む
        if (
          item.layerId !== "drum" &&
          item.layerId !== "drumAcoustic" &&
          item.layerId !== "fx"
        ) {
          // オーディオ実時間長 (元のロジックを踏襲: speed が大きいと短縮)
          const audioRealDurSec = Math.max(
            0.08,
            Math.min(item.note.durationSec, item.note.durationSec / this.speed + 0.05),
          );
          pendingOffs.push({
            // song-time 換算: 実時間 audioRealDurSec → song-time は speed 倍
            offSongSec: item.note.startSec + audioRealDurSec * this.speed,
            layerId: item.layerId,
            midi: item.note.midi,
          });
        }
      }

      // 2) note-off を fire (offSongSec <= songSec のもの)
      if (pendingOffs.length > 0) {
        for (let i = pendingOffs.length - 1; i >= 0; i--) {
          if (pendingOffs[i].offSongSec <= songSec) {
            const off = pendingOffs[i];
            holdOffFor(off.layerId, off.midi);
            // 末尾と入れ替えて pop (順序不問の安価な削除)
            pendingOffs[i] = pendingOffs[pendingOffs.length - 1];
            pendingOffs.pop();
          }
        }
      }

      // 3) 進捗通知 (200ms 程度に間引き)
      if (this.callbacks.onProgress) {
        const nowMs = performance.now();
        if (nowMs - this.lastProgressAt >= 200) {
          this.lastProgressAt = nowMs;
          const progress = Math.min(1, songSec / Math.max(0.01, this.song.totalSec));
          const currentBar = Math.min(
            this.song.chords.length,
            Math.floor(songSec / this.barSec) + 1,
          );
          this.callbacks.onProgress(progress, currentBar);
        }
      }

      // 4) 完了判定: 全 note-on/off を処理し終え、song 全長を超えたら終了
      if (
        cursor >= this.items.length &&
        pendingOffs.length === 0 &&
        songSec >= this.song.totalSec
      ) {
        this.running = false;
        if (this.tickTimer !== null) {
          window.clearInterval(this.tickTimer);
          this.tickTimer = null;
        }
        this.callbacks.onProgress?.(1, this.song.chords.length);
        this.callbacks.onComplete?.();
      }
    };

    this.tickTimer = window.setInterval(tick, TICK_MS) as unknown as number;
    tick(); // 初回即時実行 (startSec=0 のノートを 1 ティック待たずに発音)
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
