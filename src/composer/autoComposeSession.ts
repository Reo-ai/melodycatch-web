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
import {
  guitarHoldOff,
  guitarHoldOn,
  leadGuitarReleaseAll,
  leadGuitarTriggerNote,
} from "../audio/guitarEngine";
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

/**
 * 2本目のギター (リード) を別エンジンで鳴らすためのオーバーライド。
 * PianoRoll 上は同じ guitar レイヤーに表示しつつ、発音だけ leadGuitar* を使う。
 */
export type EngineOverride = "leadGuitar";

interface ScheduledItem {
  layerId: LayerId;
  note: NoteEvent;
  engine?: EngineOverride;
}

export interface ExtraStream {
  layerId: LayerId;
  notes: NoteEvent[];
  /** PianoRoll は layerId に表示するが、発音はこちらで上書きする */
  engine?: EngineOverride;
}

function holdOnFor(
  layerId: LayerId,
  midi: number,
  velocity: number,
  durationSec = 0.25,
  engine?: EngineOverride,
): void {
  if (engine === "leadGuitar") {
    leadGuitarTriggerNote(midi, durationSec, velocity);
    return;
  }
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

function holdOffFor(layerId: LayerId, midi: number, engine?: EngineOverride): void {
  if (engine === "leadGuitar") {
    // lead guitar は triggerAttackRelease で発音時に長さを渡しているので
    // 個別の off は不要。stop() 時に leadGuitarReleaseAll で一括停止される。
    return;
  }
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

/** look-ahead 用の note-off エントリ (実時間基準)。
 *  song-time 基準にしてしまうと、メインスレッドがストールして
 *  catch-up したときに on と off が同じティックで発火し、
 *  ノートが鳴る前に止まる (= 「音が鳴らない」現象) が起きる。
 *  実時間で計測することで、ティックがどれだけ遅れても
 *  各ノートが少なくとも intended な実時間長だけ鳴ることを保証する。 */
interface PendingOff {
  /** performance.now() ベースの実時間 ms。これを過ぎたら holdOff を呼ぶ */
  offRealMs: number;
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
  /** 直前 tick の実時刻 (ms)。メインスレッドストール検出に使う。
   *  この値と現在の performance.now() の差が大きすぎる場合 = ストール発生 とみなし、
   *  startedAt を補正することで song-time の急激な進行 (= ノートのバースト発射) を防ぐ。 */
  private lastTickRealMs = 0;

  constructor(
    song: ComposedSong,
    callbacks: AutoComposeCallbacks,
    extraStreams: ExtraStream[] = [],
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
      s.notes.map((n) => ({ layerId: s.layerId, note: n, engine: s.engine })),
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
    this.lastTickRealMs = 0;

    // song-time 秒で記録される note-on / note-off 進行管理。
    let cursor = 0;
    const pendingOffs: PendingOff[] = [];
    const TICK_MS = 25;
    /** look-ahead (song-time 秒)。次ティック分を先取りして
     *  ティック境界による発音の遅れを 1 ティック以内に抑える。 */
    const LOOKAHEAD_SONG_SEC = (TICK_MS / 1000) * this.speed;
    /** ストール検出のしきい値。前回 tick からこれ以上経過していたら
     *  メインスレッドが詰まっていたとみなし、その間ぶん song-time を進めずに
     *  startedAt を後ろにずらして「一時停止」扱いにする。
     *  TICK_MS=25 に対して 80ms = 3 tick 分以上の遅延を stall とみなす。 */
    const STALL_THRESHOLD_MS = 80;

    const tick = () => {
      if (!this.running) return;
      // 例外が出ても再帰チェーンを切らないように try/finally でガード。
      // 個別のノート発音で何か (オーディオエンジン側の一時エラー等) 起きても
      // 自動作曲セッション全体が止まらないようにする。
      let completed = false;
      try {
        const tickRealMs = performance.now();
        // --- ストール吸収 -------------------------------------------------
        // 前回 tick からの実時間ギャップが STALL_THRESHOLD_MS を超えたら
        // メインスレッドが詰まっていたとみなし、その間に進むはずだった
        // song-time を「無かったこと」にする (startedAt を前進させる)。
        // これにより song-time は連続的に進み、ノートが単一 tick に
        // 集中爆発するのを防ぐ (= 「途中で速くなる」現象の根本対策)。
        if (this.lastTickRealMs > 0) {
          const gap = tickRealMs - this.lastTickRealMs;
          if (gap > STALL_THRESHOLD_MS) {
            // 想定の TICK_MS だけは進めて、残りは startedAt を巻き戻して吸収。
            const absorbMs = gap - TICK_MS;
            this.startedAt += absorbMs;
          }
        }
        this.lastTickRealMs = tickRealMs;

        const elapsedRealSec = (tickRealMs - this.startedAt) / 1000;
        const songSec = elapsedRealSec * this.speed;
        const horizon = songSec + LOOKAHEAD_SONG_SEC;

        // 1) note-on を fire (cursor 以降で startSec <= horizon のもの)
        //    各ノート単位で try/catch することで、1 個失敗しても残りは進む。
        while (
          cursor < this.items.length &&
          this.items[cursor].note.startSec <= horizon
        ) {
          const item = this.items[cursor++];
          try {
            this.callbacks.onAddNote(item.layerId, item.note);
            holdOnFor(
              item.layerId,
              item.note.midi,
              item.note.velocity,
              item.note.durationSec,
              item.engine,
            );
            if (
              item.layerId !== "drum" &&
              item.layerId !== "drumAcoustic" &&
              item.layerId !== "fx" &&
              item.engine !== "leadGuitar"
            ) {
              const audioRealDurSec = Math.max(
                0.08,
                Math.min(item.note.durationSec, item.note.durationSec / this.speed + 0.05),
              );
              pendingOffs.push({
                offRealMs: tickRealMs + Math.max(60, audioRealDurSec * 1000),
                layerId: item.layerId,
                midi: item.note.midi,
              });
            }
          } catch (e) {
            console.warn("[AutoComposeSession] note-on failed", item, e);
          }
        }

        // 2) note-off を fire (offRealMs <= 現在実時間 のもの)
        if (pendingOffs.length > 0) {
          const nowMs = performance.now();
          for (let i = pendingOffs.length - 1; i >= 0; i--) {
            if (pendingOffs[i].offRealMs <= nowMs) {
              const off = pendingOffs[i];
              try {
                holdOffFor(off.layerId, off.midi);
              } catch (e) {
                console.warn("[AutoComposeSession] note-off failed", off, e);
              }
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
            try {
              this.callbacks.onProgress(progress, currentBar);
            } catch (e) {
              console.warn("[AutoComposeSession] onProgress failed", e);
            }
          }
        }

        // 4) 完了判定: 全 note-on/off を処理し終え、song 全長を超えたら終了
        if (
          cursor >= this.items.length &&
          pendingOffs.length === 0 &&
          songSec >= this.song.totalSec
        ) {
          completed = true;
          this.running = false;
          if (this.tickTimer !== null) {
            window.clearTimeout(this.tickTimer);
            this.tickTimer = null;
          }
          try {
            this.callbacks.onProgress?.(1, this.song.chords.length);
          } catch (e) {
            console.warn("[AutoComposeSession] final onProgress failed", e);
          }
          try {
            this.callbacks.onComplete?.();
          } catch (e) {
            console.warn("[AutoComposeSession] onComplete failed", e);
          }
        }
      } catch (e) {
        // tick 全体で予期しない例外が起きた場合も再帰チェーンは止めない
        console.warn("[AutoComposeSession] tick error", e);
      } finally {
        // 完了 / 停止以外は必ず次ティックを予約する。
        // try 内で例外が出てもチェーンが切れないことを保証する。
        if (!completed && this.running) {
          this.tickTimer = window.setTimeout(tick, TICK_MS) as unknown as number;
        }
      }
    };

    this.tickTimer = window.setTimeout(tick, 0) as unknown as number;
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer !== null) {
      window.clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    // 2本目ギター (リード) は triggerAttackRelease 駆動なので
    // 停止時に余韻を含め一括解放しておく。
    try {
      leadGuitarReleaseAll();
    } catch (e) {
      console.warn("[AutoComposeSession] leadGuitarReleaseAll failed", e);
    }
  }
}
