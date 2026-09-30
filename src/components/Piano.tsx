/**
 * Full 88-key piano component.
 *
 * - Range: A0 (MIDI 21) ... C8 (MIDI 108) — full grand piano range.
 * - Horizontal scrolling for narrow screens; auto-centers on Middle C on first mount.
 * - Pointer + multi-touch capable: drag your finger to glissando, hold multiple keys for chords.
 * - Visually highlights:
 *     - keys belonging to the active scale (if `scale` is provided)
 *     - keys currently being played (`activeNotes`)
 *     - keys highlighted as the suggested chord (`spotlightNotes`)
 */

import { useEffect, useMemo, useRef, memo } from "react";
import { isBlackKey, noteName, pitchClass } from "../music/pitch";
import type { Scale } from "../music/scale";
import { scaleContains } from "../music/scale";

const FIRST_MIDI = 21; // A0
const LAST_MIDI = 108; // C8
const WHITE_KEY_WIDTH = 36; // px
const WHITE_KEY_HEIGHT = 180;
const BLACK_KEY_WIDTH = 22;
const BLACK_KEY_HEIGHT = 116;

interface PianoProps {
  scale?: Scale | null;
  /** Notes currently sounding (user touch / keyboard). */
  activeNotes?: Set<number>;
  /** Notes to highlight as a chord recommendation (e.g. last clicked chord). */
  spotlightNotes?: Set<number>;
  onNoteOn: (midi: number) => void;
  onNoteOff: (midi: number) => void;
  /** Pixel height. Defaults to 180. */
  height?: number;
  /** Auto-scroll to center this MIDI note on mount. Defaults to 60 (C4). */
  initialCenterMidi?: number;
}

function Piano({
  scale,
  activeNotes,
  spotlightNotes,
  onNoteOn,
  onNoteOff,
  height = WHITE_KEY_HEIGHT,
  initialCenterMidi = 60,
}: PianoProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pressed = useRef<Set<number>>(new Set());

  // Generate keys
  const { whiteKeys, blackKeys, totalWidth } = useMemo(() => {
    const whites: { midi: number; x: number }[] = [];
    const blacks: { midi: number; x: number }[] = [];
    let x = 0;
    for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
      if (!isBlackKey(m)) {
        whites.push({ midi: m, x });
        x += WHITE_KEY_WIDTH;
      }
    }
    // Black keys are positioned between two adjacent whites.
    for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
      if (isBlackKey(m)) {
        // Find the white key just to the left and just to the right.
        const leftWhite = whites.findLast((w) => w.midi < m);
        if (!leftWhite) continue;
        const bx = leftWhite.x + WHITE_KEY_WIDTH - BLACK_KEY_WIDTH / 2;
        blacks.push({ midi: m, x: bx });
      }
    }
    return { whiteKeys: whites, blackKeys: blacks, totalWidth: x };
  }, []);

  // Auto-scroll to center on initialCenterMidi on first mount.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = whiteKeys.find((k) => k.midi >= initialCenterMidi) ?? whiteKeys[0];
    const targetX = target.x + WHITE_KEY_WIDTH / 2;
    el.scrollLeft = Math.max(0, targetX - el.clientWidth / 2);
  }, [whiteKeys, initialCenterMidi]);

  // Pointer / touch handlers --------------------------------------------------
  function press(midi: number) {
    if (pressed.current.has(midi)) return;
    pressed.current.add(midi);
    onNoteOn(midi);
  }

  function release(midi: number) {
    if (!pressed.current.has(midi)) return;
    pressed.current.delete(midi);
    onNoteOff(midi);
  }

  function midiFromPointerEvent(e: React.PointerEvent | PointerEvent): number | null {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target) return null;
    const midiAttr = (target as HTMLElement).dataset?.midi;
    return midiAttr ? Number(midiAttr) : null;
  }

  function handlePointerDown(e: React.PointerEvent) {
    // タッチでは setPointerCapture しない (キャプチャすると親の touch-pan-x が効かず、
    // 88 鍵を横スワイプでスクロールできなくなる)。マウスは従来通りキャプチャしてグリッサンドを許可。
    if (e.pointerType === "mouse") {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    const midi = midiFromPointerEvent(e);
    if (midi != null) press(midi);
  }

  function handlePointerMove(e: React.PointerEvent) {
    // タッチではグリッサンド処理をスキップしてブラウザの横スクロールに任せる。
    if (e.pointerType !== "mouse") return;
    // Only treat as glissando if pointer is being pressed.
    if (e.buttons === 0) return;
    const midi = midiFromPointerEvent(e);
    // Release any previously-held note that isn't the current target.
    pressed.current.forEach((m) => {
      if (m !== midi) release(m);
    });
    if (midi != null) press(midi);
  }

  function handlePointerUp(e: React.PointerEvent) {
    const midi = midiFromPointerEvent(e);
    if (midi != null) release(midi);
    // Safety: release all if the user lifts off.
    pressed.current.forEach((m) => release(m));
  }

  function handlePointerCancel() {
    pressed.current.forEach((m) => release(m));
  }

  // Render --------------------------------------------------------------------

  function isInScale(midi: number): boolean {
    if (!scale) return true;
    return scaleContains(scale, midi);
  }

  function isActive(midi: number): boolean {
    return activeNotes?.has(midi) ?? false;
  }

  function isSpotlight(midi: number): boolean {
    return spotlightNotes?.has(midi) ?? false;
  }

  function isRoot(midi: number): boolean {
    return scale ? pitchClass(midi) === scale.rootPitchClass : false;
  }

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-white/10 bg-black p-1 pt-0 shadow-[inset_0_8px_16px_-8px_rgba(0,0,0,0.9)]">
      <div
        ref={scrollRef}
        className="overflow-x-auto overflow-y-hidden no-scrollbar touch-pan-x"
        style={{ height }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerCancel}
      >
        <div
          className="relative select-none"
          style={{ width: totalWidth, height }}
        >
          {/* White keys */}
          {whiteKeys.map(({ midi, x }) => {
            const inScale = isInScale(midi);
            const active = isActive(midi);
            const spot = isSpotlight(midi);
            const root = isRoot(midi);
            return (
              <button
                key={`w-${midi}`}
                data-midi={midi}
                aria-label={noteName(midi)}
                className={[
                  "absolute top-0 border border-black/40 rounded-b-md transition-colors",
                  active
                    ? "bg-accent-500"
                    : spot
                      ? "bg-violet-200"
                      : inScale
                        ? "bg-gradient-to-b from-zinc-100 to-white"
                        : "bg-zinc-300",
                  root ? "ring-1 ring-accent-400 ring-inset" : "",
                ].join(" ")}
                style={{
                  left: x,
                  width: WHITE_KEY_WIDTH,
                  height,
                  // pan-x: 横スワイプは 88 鍵スクロールに譲り、タップで発音する。
                  touchAction: "pan-x",
                }}
              >
                <span
                  className={[
                    "absolute bottom-1 left-0 right-0 text-center text-[10px]",
                    active ? "text-white" : "text-zinc-500",
                  ].join(" ")}
                >
                  {pitchClass(midi) === 0 ? noteName(midi) : ""}
                </span>
              </button>
            );
          })}
          {/* Black keys (rendered on top) */}
          {blackKeys.map(({ midi, x }) => {
            const inScale = isInScale(midi);
            const active = isActive(midi);
            const spot = isSpotlight(midi);
            return (
              <button
                key={`b-${midi}`}
                data-midi={midi}
                aria-label={noteName(midi)}
                className={[
                  "absolute top-0 rounded-b-md transition-colors z-10",
                  active
                    ? "bg-accent-500"
                    : spot
                      ? "bg-violet-500"
                      : inScale
                        ? "bg-gradient-to-b from-zinc-800 to-zinc-950 shadow-[0_2px_4px_rgba(0,0,0,0.6)]"
                        : "bg-zinc-700",
                ].join(" ")}
                style={{
                  left: x,
                  width: BLACK_KEY_WIDTH,
                  height: Math.min(BLACK_KEY_HEIGHT, height * 0.65),
                  touchAction: "pan-x",
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// 渡されたデータが変わった時だけ描き直す (親の Studio が再生中に頻繁に描き直されても巻き込まれないように)
export default memo(Piano);
