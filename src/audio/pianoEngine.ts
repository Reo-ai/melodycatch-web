/**
 * Lightweight wrapper around Tone.js for piano sound playback.
 * - Lazy-initializes AudioContext on first user gesture (browser policy).
 * - Loads a small high-quality piano sample set from a CDN.
 * - Falls back to a synthesized polyphonic piano if samples fail to load.
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

let sampler: Tone.Sampler | null = null;
let fallback: Tone.PolySynth | null = null;
let started = false;
let loading: Promise<void> | null = null;

/**
 * Salamander Grand Piano samples hosted on tonejs.github.io.
 * Maintained by the Tone.js project; CORS-friendly.
 */
const PIANO_SAMPLES_BASE = "https://tonejs.github.io/audio/salamander/";
const PIANO_SAMPLES: Record<string, string> = {
  A0: "A0.mp3",
  C1: "C1.mp3",
  "D#1": "Ds1.mp3",
  "F#1": "Fs1.mp3",
  A1: "A1.mp3",
  C2: "C2.mp3",
  "D#2": "Ds2.mp3",
  "F#2": "Fs2.mp3",
  A2: "A2.mp3",
  C3: "C3.mp3",
  "D#3": "Ds3.mp3",
  "F#3": "Fs3.mp3",
  A3: "A3.mp3",
  C4: "C4.mp3",
  "D#4": "Ds4.mp3",
  "F#4": "Fs4.mp3",
  A4: "A4.mp3",
  C5: "C5.mp3",
  "D#5": "Ds5.mp3",
  "F#5": "Fs5.mp3",
  A5: "A5.mp3",
  C6: "C6.mp3",
  "D#6": "Ds6.mp3",
  "F#6": "Fs6.mp3",
  A6: "A6.mp3",
  C7: "C7.mp3",
  "D#7": "Ds7.mp3",
  "F#7": "Fs7.mp3",
  A7: "A7.mp3",
  C8: "C8.mp3",
};

/** Ensure AudioContext is running. Call from a user-gesture handler. */
export async function ensureAudio(): Promise<void> {
  if (!started) {
    await Tone.start();
    started = true;
  }
  if (!sampler && !loading) {
    loading = loadSampler();
  }
  if (loading) await loading;
}

async function loadSampler(): Promise<void> {
  try {
    const s = new Tone.Sampler({
      urls: PIANO_SAMPLES,
      baseUrl: PIANO_SAMPLES_BASE,
      release: 1.2,
      onerror: (err) => {
        console.warn("Piano sampler failed to load:", err);
      },
    }).toDestination();
    await Tone.loaded();
    sampler = s;
  } catch (err) {
    console.warn("Falling back to synthesized piano:", err);
    fallback = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.4, release: 1.0 },
    }).toDestination();
  }
}

/** Returns the active output (sampler if loaded, otherwise fallback). */
function output(): Tone.Sampler | Tone.PolySynth | null {
  return sampler ?? fallback;
}

/** Play a single note immediately. */
export function noteOn(midi: number, velocity = 0.85, duration = 0.4): void {
  const out = output();
  if (!out) return;
  const note = midiToNoteString(midi);
  out.triggerAttackRelease(note, duration, undefined, velocity);
}

/** Play multiple notes simultaneously (a chord). */
export function chordOn(midiNotes: number[], velocity = 0.8, duration = 1.4): void {
  const out = output();
  if (!out) return;
  const notes = midiNotes.map(midiToNoteString);
  out.triggerAttackRelease(notes, duration, undefined, velocity);
}

/** Hold-style note-on (used for sustained piano-key press). */
export function holdOn(midi: number, velocity = 0.85): void {
  const out = output();
  if (!out) return;
  out.triggerAttack(midiToNoteString(midi), undefined, velocity);
}

export function holdOff(midi: number): void {
  const out = output();
  if (!out) return;
  out.triggerRelease(midiToNoteString(midi));
}

/** Release all notes. */
export function releaseAll(): void {
  const out = output();
  if (!out) return;
  if (out instanceof Tone.PolySynth) {
    out.releaseAll();
  } else if (out instanceof Tone.Sampler) {
    out.releaseAll();
  }
}
