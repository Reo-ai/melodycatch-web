/**
 * Header-style picker for choosing the key (root) and scale kind.
 *
 * - 12-note key picker shown as a horizontally-scrollable pill row.
 * - Scale-kind picker shown as a dropdown to keep the header compact.
 * - All labels are Japanese-friendly.
 */

import { SHARP_NAMES } from "../music/pitch";
import {
  ALL_SCALE_KINDS,
  SCALE_DISPLAY_NAMES_JA,
  SCALE_MOOD_JA,
  type Scale,
  type ScaleKind,
} from "../music/scale";

interface ScalePickerProps {
  scale: Scale;
  onChange: (scale: Scale) => void;
}

export default function ScalePicker({ scale, onChange }: ScalePickerProps) {
  function setRoot(rootPitchClass: number) {
    onChange({ ...scale, rootPitchClass });
  }

  function setKind(kind: ScaleKind) {
    onChange({ ...scale, kind });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 text-xs font-medium text-ink-500">キー (調)</div>
        <div className="flex flex-wrap gap-1.5">
          {SHARP_NAMES.map((name, i) => {
            const active = scale.rootPitchClass === i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setRoot(i)}
                className={[
                  "min-w-[2.25rem] rounded-full border px-2 py-1 text-sm font-semibold transition",
                  active
                    ? "border-accent-500 bg-accent-500 text-white shadow-sm"
                    : "border-ink-200 bg-white text-ink-700 hover:border-accent-300",
                ].join(" ")}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-ink-500">スケール</div>
        <div className="flex flex-wrap gap-1.5">
          {ALL_SCALE_KINDS.map((kind) => {
            const active = scale.kind === kind;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => setKind(kind)}
                className={[
                  "rounded-full border px-3 py-1 text-sm transition",
                  active
                    ? "border-accent-500 bg-accent-500 text-white shadow-sm"
                    : "border-ink-200 bg-white text-ink-700 hover:border-accent-300",
                ].join(" ")}
                title={SCALE_MOOD_JA[kind]}
              >
                {SCALE_DISPLAY_NAMES_JA[kind]}
              </button>
            );
          })}
        </div>
        <div className="mt-1 text-xs text-ink-500">
          {SCALE_MOOD_JA[scale.kind]}
        </div>
      </div>
    </div>
  );
}
