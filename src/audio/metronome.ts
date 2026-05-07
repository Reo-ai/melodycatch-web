/**
 * メトロノーム。
 *
 * - Tone.Loop + 短いクリック音 (square wave) で BPM 基準の拍を刻む。
 * - 4 拍ごとに頭拍 (downbeat) は強く高い音、それ以外は弱く低い音。
 * - 録音/再生中も独立して動く (Tone.Transport を専用で使う)。
 */

import * as Tone from "tone";

let metroSynth: Tone.Synth | null = null;
let metroLoop: Tone.Loop | null = null;
let beatCount = 0;
let running = false;

function ensureMetro() {
  if (metroSynth) return;
  metroSynth = new Tone.Synth({
    oscillator: { type: "square" },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.04 },
    volume: -16,
  }).toDestination();
}

export function startMetronome(bpm: number): void {
  ensureMetro();
  Tone.Transport.bpm.value = bpm;
  beatCount = 0;
  if (metroLoop) {
    metroLoop.stop();
    metroLoop.dispose();
    metroLoop = null;
  }
  metroLoop = new Tone.Loop((time) => {
    const isDownbeat = beatCount % 4 === 0;
    metroSynth!.triggerAttackRelease(
      isDownbeat ? "G5" : "G4",
      0.04,
      time,
      isDownbeat ? 0.95 : 0.55,
    );
    beatCount++;
  }, "4n");
  metroLoop.start(0);
  if (Tone.Transport.state !== "started") {
    Tone.Transport.start();
  }
  running = true;
}

export function stopMetronome(): void {
  if (metroLoop) {
    metroLoop.stop();
    metroLoop.dispose();
    metroLoop = null;
  }
  // 他で Tone.Transport を使っていないので止めて OK
  Tone.Transport.stop();
  Tone.Transport.cancel();
  running = false;
}

export function setMetronomeBpm(bpm: number): void {
  Tone.Transport.bpm.value = bpm;
}

export function isMetronomeRunning(): boolean {
  return running;
}
