/**
 * ドラムパッド UI。
 *
 * - 5 つのパターン (8ビート/16ビート/バラード/ボサノバ/シャッフル) からカード選択
 * - 各 step (Kick/Snare/Hi-hat × 16) をクリックで自由にトグル
 * - 「リセット」でプリセット通りに戻す
 * - BPM は親から制御 (props)。スライダで親に伝える
 * - 再生 / 停止 (forwardRef で親から start/stop も呼べる)
 * - 再生中は各ヒットで onHit(midi, velocity) を発火 → 録音と連動
 *
 * オーディオ生成は ../audio/drums の DrumLoop に委譲する。
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clonePattern,
  DRUM_HIHAT_MIDI,
  DRUM_KICK_MIDI,
  DRUM_PATTERNS,
  DRUM_SNARE_MIDI,
  DrumLoop,
  type DrumPattern,
  type DrumPatternId,
} from "../audio/drums";
import { ensureAudio } from "../audio/pianoEngine";

export interface DrumPadHandle {
  start: () => Promise<void>;
  stop: () => void;
  isPlaying: () => boolean;
}

interface DrumPadProps {
  /** 親で持つ BPM (60〜180) */
  bpm: number;
  onBpmChange: (bpm: number) => void;
  defaultPatternId?: DrumPatternId;
  /** 再生中の各ヒットで発火 (録音側で使う) */
  onHit?: (midi: number, velocity: number) => void;
  /** 再生状態が変わったら通知 (親 UI 同期用) */
  onPlayingChange?: (playing: boolean) => void;
}

const DrumPad = forwardRef<DrumPadHandle, DrumPadProps>(function DrumPad(
  {
    bpm,
    onBpmChange,
    defaultPatternId = "rock8",
    onHit,
    onPlayingChange,
  },
  ref,
) {
  const loopRef = useRef<DrumLoop | null>(null);
  const onHitRef = useRef<typeof onHit>(undefined);
  const [patternId, setPatternId] = useState<DrumPatternId>(defaultPatternId);
  const [pattern, setPattern] = useState<DrumPattern>(() =>
    clonePattern(
      DRUM_PATTERNS.find((p) => p.id === defaultPatternId) ?? DRUM_PATTERNS[0],
    ),
  );
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(-1);

  // onHit を ref で保持 (DrumLoop に直接渡すと毎回 setOnHit が必要なため)
  useEffect(() => {
    onHitRef.current = onHit;
  }, [onHit]);

  // DrumLoop インスタンスを 1 回だけ用意
  useEffect(() => {
    const dl = new DrumLoop();
    dl.setOnStep((s) => setStep(s));
    dl.setOnHit((midi, vel) => onHitRef.current?.(midi, vel));
    loopRef.current = dl;
    return () => {
      dl.dispose();
      loopRef.current = null;
    };
  }, []);

  // パターン (編集後の現在値) を即時反映
  useEffect(() => {
    loopRef.current?.setPattern(pattern);
  }, [pattern]);

  // パターン ID 変更時はプリセットからクローンして編集状態を初期化
  useEffect(() => {
    const preset =
      DRUM_PATTERNS.find((p) => p.id === patternId) ?? DRUM_PATTERNS[0];
    setPattern(clonePattern(preset));
  }, [patternId]);

  // BPM をリアルタイム反映
  useEffect(() => {
    if (loopRef.current?.isPlaying()) loopRef.current.setBpm(bpm);
  }, [bpm]);

  // playing が変わったら親に通知
  useEffect(() => {
    onPlayingChange?.(playing);
  }, [playing, onPlayingChange]);

  async function start() {
    await ensureAudio();
    loopRef.current?.start(pattern, bpm);
    setPlaying(true);
  }

  function stop() {
    loopRef.current?.stop();
    setPlaying(false);
    setStep(-1);
  }

  // 親からの imperative 操作
  useImperativeHandle(
    ref,
    () => ({
      start,
      stop,
      isPlaying: () => loopRef.current?.isPlaying() ?? false,
    }),
    // start/stop は同一インスタンス内で安定 (state 経由)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function toggleStep(track: "kick" | "snare" | "hihat", index: number) {
    setPattern((cur) => {
      const next = clonePattern(cur);
      next[track][index] = !next[track][index];
      return next;
    });
  }

  function resetPattern() {
    const preset =
      DRUM_PATTERNS.find((p) => p.id === patternId) ?? DRUM_PATTERNS[0];
    setPattern(clonePattern(preset));
  }

  const isEdited = useMemo(() => {
    const preset =
      DRUM_PATTERNS.find((p) => p.id === patternId) ?? DRUM_PATTERNS[0];
    return (
      !arrEq(preset.kick, pattern.kick) ||
      !arrEq(preset.snare, pattern.snare) ||
      !arrEq(preset.hihat, pattern.hihat)
    );
  }, [pattern, patternId]);

  return (
    <div className="flex flex-col gap-3">
      {/* パターン選択 */}
      <div
        role="radiogroup"
        aria-label="ドラムパターン"
        className="grid grid-cols-2 gap-2 sm:grid-cols-5"
      >
        {DRUM_PATTERNS.map((p) => {
          const active = p.id === patternId;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPatternId(p.id)}
              className={[
                "flex flex-col items-start rounded-xl border p-2.5 text-left transition",
                "active:scale-[0.98]",
                active
                  ? "border-accent-500 bg-accent-50 ring-2 ring-accent-300/60"
                  : "border-ink-200 bg-white hover:border-accent-300",
              ].join(" ")}
            >
              <span className="text-sm font-semibold text-ink-900">
                {p.name}
              </span>
              <span className="text-[11px] text-ink-500">{p.description}</span>
            </button>
          );
        })}
      </div>

      {/* BPM + コントロール */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-white p-3">
        <label className="flex flex-1 min-w-[200px] items-center gap-3">
          <span className="text-xs font-semibold text-ink-700">
            BPM
            <span className="ml-2 font-mono tabular-nums text-ink-900">
              {bpm}
            </span>
          </span>
          <input
            type="range"
            min={60}
            max={180}
            step={1}
            value={bpm}
            onChange={(e) => onBpmChange(Number(e.target.value))}
            className="flex-1 accent-accent-500"
          />
        </label>

        {!playing ? (
          <button
            type="button"
            onClick={start}
            className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-accent-600"
          >
            ▶ ドラム再生
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="rounded-full bg-ink-900 px-4 py-1.5 text-sm font-semibold text-white shadow-sm"
          >
            ■ 停止
          </button>
        )}
      </div>

      {/* 編集可能な 16-step グリッド */}
      <div className="rounded-xl border border-ink-200 bg-ink-50 p-2">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold text-ink-600">
            🥁 各セルをタップして音を増減できます
          </span>
          {isEdited && (
            <button
              type="button"
              onClick={resetPattern}
              className="rounded-full border border-ink-300 bg-white px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
            >
              ↺ プリセットに戻す
            </button>
          )}
        </div>
        <EditableStepRow
          label="K"
          color="rose"
          steps={pattern.kick}
          activeStep={step}
          onToggle={(i) => toggleStep("kick", i)}
          aria="キック"
          midi={DRUM_KICK_MIDI}
        />
        <EditableStepRow
          label="S"
          color="amber"
          steps={pattern.snare}
          activeStep={step}
          onToggle={(i) => toggleStep("snare", i)}
          aria="スネア"
          midi={DRUM_SNARE_MIDI}
        />
        <EditableStepRow
          label="H"
          color="sky"
          steps={pattern.hihat}
          activeStep={step}
          onToggle={(i) => toggleStep("hihat", i)}
          aria="ハイハット"
          midi={DRUM_HIHAT_MIDI}
        />
      </div>
    </div>
  );
});

export default DrumPad;

function EditableStepRow({
  label,
  color,
  steps,
  activeStep,
  onToggle,
  aria,
  midi,
}: {
  label: string;
  color: "rose" | "amber" | "sky";
  steps: boolean[];
  activeStep: number;
  onToggle: (index: number) => void;
  aria: string;
  midi: number;
}) {
  const onColor =
    color === "rose"
      ? "bg-rose-500 hover:bg-rose-600"
      : color === "amber"
        ? "bg-amber-500 hover:bg-amber-600"
        : "bg-sky-500 hover:bg-sky-600";
  return (
    <div
      className="flex items-center gap-1.5 py-0.5"
      aria-label={`${aria} (MIDI ${midi})`}
    >
      <span className="w-4 text-[10px] font-bold text-ink-500">{label}</span>
      <div
        className="grid flex-1 gap-1"
        style={{ gridTemplateColumns: "repeat(16, minmax(0,1fr))" }}
      >
        {steps.map((on, i) => {
          const isCurrent = i === activeStep;
          const isBeat = i % 4 === 0;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onToggle(i)}
              aria-label={`${aria} ステップ ${i + 1} ${on ? "オン" : "オフ"}`}
              aria-pressed={on}
              className={[
                "h-5 rounded-sm border transition active:scale-90",
                on
                  ? `${onColor} border-transparent`
                  : isBeat
                    ? "bg-white border-ink-300 hover:bg-ink-100"
                    : "bg-white border-ink-200 hover:bg-ink-100",
                isCurrent ? "outline outline-2 outline-accent-400" : "",
              ].join(" ")}
            />
          );
        })}
      </div>
    </div>
  );
}

function arrEq(a: boolean[], b: boolean[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
