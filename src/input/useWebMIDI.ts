/**
 * Web MIDI 入力フック。
 *
 * - `navigator.requestMIDIAccess()` で全 MIDI 入力デバイスを購読する。
 * - Note On (status 0x90, velocity > 0) → onNoteOn
 * - Note Off (status 0x80, または Note On velocity 0) → onNoteOff
 */

import { useEffect, useState } from "react";

export interface MIDIStatus {
  supported: boolean;
  enabled: boolean;
  devices: string[];
  error: string | null;
}

interface Options {
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
}

// 環境によっては Web MIDI 型が無いので最小限を独自宣言してアクセスする。
interface MIDIMessageLike {
  data: Uint8Array;
}
interface MIDIInputLike {
  name?: string | null;
  onmidimessage: ((e: MIDIMessageLike) => void) | null;
}
interface MIDIInputMapLike {
  values(): IterableIterator<MIDIInputLike>;
}
interface MIDIAccessLike {
  inputs: MIDIInputMapLike;
  onstatechange: (() => void) | null;
}
interface NavigatorWithMIDI {
  requestMIDIAccess?: () => Promise<unknown>;
}

export function useWebMIDI({ onNoteOn, onNoteOff }: Options): MIDIStatus {
  const [status, setStatus] = useState<MIDIStatus>({
    supported:
      typeof navigator !== "undefined" &&
      typeof (navigator as unknown as NavigatorWithMIDI).requestMIDIAccess ===
        "function",
    enabled: false,
    devices: [],
    error: null,
  });

  useEffect(() => {
    const nav = navigator as unknown as NavigatorWithMIDI;
    if (typeof nav.requestMIDIAccess !== "function") return;

    let access: MIDIAccessLike | null = null;
    let cancelled = false;

    function handle(e: MIDIMessageLike) {
      const [status, data1, data2] = e.data;
      const cmd = status & 0xf0;
      if (cmd === 0x90 && data2 > 0) {
        onNoteOn(data1, data2 / 127);
      } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
        onNoteOff(data1);
      }
    }

    function bind(a: MIDIAccessLike) {
      const names: string[] = [];
      for (const input of a.inputs.values()) {
        input.onmidimessage = handle;
        if (input.name) names.push(input.name);
      }
      setStatus((s) => ({ ...s, enabled: true, devices: names, error: null }));
    }

    nav
      .requestMIDIAccess()
      .then((raw) => {
        if (cancelled) return;
        access = raw as MIDIAccessLike;
        bind(access);
        access.onstatechange = () => {
          if (access) bind(access);
        };
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus((s) => ({ ...s, error: msg }));
      });

    return () => {
      cancelled = true;
      if (access) {
        for (const input of access.inputs.values()) {
          input.onmidimessage = null;
        }
        access.onstatechange = null;
      }
    };
  }, [onNoteOn, onNoteOff]);

  return status;
}
