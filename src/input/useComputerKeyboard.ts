/**
 * PC キーボードをピアノ鍵盤として扱うフック。
 *
 * マッピング (GarageBand 風)
 *   白鍵: Q W E R T Y U I O P  → ベース C から 10 鍵
 *   黒鍵: 2 3 _ 5 6 7 _ 9 0    (Q W _ R T Y _ I O の上)
 *   Z / X : ベースを 1 オクターブ下/上 (C2〜C6 まで)
 *
 * - ノートリピート(キーリピート)は無視。
 * - フォーム要素 (input, textarea, contenteditable) では無効。
 */

import { useEffect, useRef } from "react";

interface Options {
  enabled: boolean;
  onNoteOn: (midi: number) => void;
  onNoteOff: (midi: number) => void;
}

/** key → semitone offset from base C. */
const KEY_TO_OFFSET: Record<string, number> = {
  // 白鍵
  q: 0, w: 2, e: 4, r: 5, t: 7, y: 9, u: 11, i: 12, o: 14, p: 16,
  // 黒鍵 (上段)
  "2": 1, "3": 3, "5": 6, "6": 8, "7": 10, "9": 13, "0": 15,
};

const MIN_BASE = 24; // C1
const MAX_BASE = 84; // C6
const DEFAULT_BASE = 60; // C4 (Middle C)

function isFormElement(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useComputerKeyboard({ enabled, onNoteOn, onNoteOff }: Options) {
  const baseRef = useRef<number>(DEFAULT_BASE);
  const heldRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!enabled) return;

    function down(e: KeyboardEvent) {
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isFormElement(e.target)) return;

      const k = e.key.toLowerCase();

      if (k === "z") {
        baseRef.current = Math.max(MIN_BASE, baseRef.current - 12);
        return;
      }
      if (k === "x") {
        baseRef.current = Math.min(MAX_BASE, baseRef.current + 12);
        return;
      }

      const off = KEY_TO_OFFSET[k];
      if (off === undefined) return;
      const midi = baseRef.current + off;
      if (midi < 0 || midi > 127) return;
      if (heldRef.current.has(k)) return;
      heldRef.current.set(k, midi);
      e.preventDefault();
      onNoteOn(midi);
    }

    function up(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      const midi = heldRef.current.get(k);
      if (midi === undefined) return;
      heldRef.current.delete(k);
      onNoteOff(midi);
    }

    function blur() {
      // ウィンドウがフォーカスを失ったら全部 off
      heldRef.current.forEach((midi) => onNoteOff(midi));
      heldRef.current.clear();
    }

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      blur();
    };
  }, [enabled, onNoteOn, onNoteOff]);
}
