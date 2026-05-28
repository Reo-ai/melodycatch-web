/**
 * ミックスパネル: 各楽器チャネル + マスターの音量 / ミュート / ソロを操作する。
 *
 * 各値は localStorage に保存され、リロードしても復元される。
 * 内部的には audio/mixer.ts の Tone.Channel に直接書き込む。
 */

import { useEffect, useMemo, useState } from "react";
import {
  MIXER_CHANNEL_IDS,
  MIXER_CHANNEL_LABEL_JA,
  setMixerChannelMute,
  setMixerChannelVolumeDb,
  setMixerMasterMute,
  setMixerMasterVolumeDb,
  type MixerChannelId,
} from "../audio/mixer";

const LS_KEY = "mixer.state.v1";
const MIN_DB = -40;
const MAX_DB = 6;

type ChannelState = { volumeDb: number; muted: boolean };
type MixerState = {
  master: ChannelState;
  channels: Record<MixerChannelId, ChannelState>;
};

function defaultState(): MixerState {
  const channels = {} as Record<MixerChannelId, ChannelState>;
  for (const id of MIXER_CHANNEL_IDS) {
    channels[id] = { volumeDb: 0, muted: false };
  }
  return {
    master: { volumeDb: 0, muted: false },
    channels,
  };
}

function loadState(): MixerState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<MixerState>;
    const base = defaultState();
    if (parsed.master) base.master = { ...base.master, ...parsed.master };
    if (parsed.channels) {
      for (const id of MIXER_CHANNEL_IDS) {
        const v = (parsed.channels as Record<string, ChannelState | undefined>)[id];
        if (v) base.channels[id] = { ...base.channels[id], ...v };
      }
    }
    return base;
  } catch {
    return defaultState();
  }
}

function saveState(s: MixerState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface Props {
  open: boolean;
  onToggle: () => void;
}

export function MixerPanel({ open, onToggle }: Props) {
  const [state, setState] = useState<MixerState>(() => loadState());
  // ソロ機能: ソロ ON のチャネルがあれば、それ以外は強制ミュート扱いにする。
  const [solo, setSolo] = useState<Set<MixerChannelId>>(() => new Set());

  // 初回マウント時に保存値を Tone.js 側へ反映する。
  useEffect(() => {
    setMixerMasterVolumeDb(state.master.volumeDb);
    setMixerMasterMute(state.master.muted);
    for (const id of MIXER_CHANNEL_IDS) {
      const c = state.channels[id];
      setMixerChannelVolumeDb(id, c.volumeDb);
      setMixerChannelMute(id, c.muted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ソロが変わったらミュート状態を再計算する。
  useEffect(() => {
    const hasSolo = solo.size > 0;
    for (const id of MIXER_CHANNEL_IDS) {
      const userMuted = state.channels[id].muted;
      const soloMuted = hasSolo && !solo.has(id);
      setMixerChannelMute(id, userMuted || soloMuted);
    }
  }, [solo, state.channels]);

  const update = (next: MixerState) => {
    setState(next);
    saveState(next);
  };

  const onChannelVolume = (id: MixerChannelId, v: number) => {
    setMixerChannelVolumeDb(id, v);
    update({
      ...state,
      channels: { ...state.channels, [id]: { ...state.channels[id], volumeDb: v } },
    });
  };

  const onChannelMute = (id: MixerChannelId, muted: boolean) => {
    // ソロ中ならソロを考慮した結果のミュート値を後段 useEffect が反映する。
    update({
      ...state,
      channels: { ...state.channels, [id]: { ...state.channels[id], muted } },
    });
  };

  const onChannelSolo = (id: MixerChannelId, soloed: boolean) => {
    setSolo((prev) => {
      const next = new Set(prev);
      if (soloed) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onMasterVolume = (v: number) => {
    setMixerMasterVolumeDb(v);
    update({ ...state, master: { ...state.master, volumeDb: v } });
  };

  const onMasterMute = (muted: boolean) => {
    setMixerMasterMute(muted);
    update({ ...state, master: { ...state.master, muted } });
  };

  const resetAll = () => {
    const fresh = defaultState();
    setMixerMasterVolumeDb(0);
    setMixerMasterMute(false);
    for (const id of MIXER_CHANNEL_IDS) {
      setMixerChannelVolumeDb(id, 0);
      setMixerChannelMute(id, false);
    }
    setSolo(new Set());
    update(fresh);
  };

  const channelOrder = useMemo(() => MIXER_CHANNEL_IDS, []);

  return (
    <div className="rounded-xl border border-ink-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-ink-700">
          🎚️ ミキサー
          <span className="ml-2 text-xs font-normal text-ink-500">
            楽器ごとの音量・ミュート・ソロ
          </span>
        </span>
        <span className="text-xs text-ink-500">{open ? "▲ 閉じる" : "▼ 開く"}</span>
      </button>
      {open && (
        <div className="border-t border-ink-100 px-4 pb-4 pt-3">
          {/* チャネル一覧 (横並び、各列に縦フェーダー) */}
          <div className="flex gap-3 overflow-x-auto pb-2">
            {channelOrder.map((id) => {
              const c = state.channels[id];
              const isSolo = solo.has(id);
              const otherSoloed = solo.size > 0 && !isSolo;
              return (
                <ChannelStrip
                  key={id}
                  label={MIXER_CHANNEL_LABEL_JA[id]}
                  volumeDb={c.volumeDb}
                  muted={c.muted}
                  soloed={isSolo}
                  dimmed={otherSoloed}
                  onVolume={(v) => onChannelVolume(id, v)}
                  onMute={(m) => onChannelMute(id, m)}
                  onSolo={(s) => onChannelSolo(id, s)}
                />
              );
            })}
            {/* マスター */}
            <div className="ml-2 flex-shrink-0 border-l border-ink-200 pl-3">
              <ChannelStrip
                label="マスター"
                isMaster
                volumeDb={state.master.volumeDb}
                muted={state.master.muted}
                onVolume={onMasterVolume}
                onMute={onMasterMute}
              />
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
            <span>各フェーダーは dB 値。0 dB が等倍、-∞ で無音、+6 dB まで上げられる。</span>
            <button
              type="button"
              onClick={resetAll}
              className="rounded-full border border-ink-200 px-3 py-1 text-ink-600 hover:bg-ink-50"
            >
              全リセット
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface StripProps {
  label: string;
  volumeDb: number;
  muted: boolean;
  soloed?: boolean;
  dimmed?: boolean;
  isMaster?: boolean;
  onVolume: (v: number) => void;
  onMute: (m: boolean) => void;
  onSolo?: (s: boolean) => void;
}

function ChannelStrip({
  label,
  volumeDb,
  muted,
  soloed = false,
  dimmed = false,
  isMaster = false,
  onVolume,
  onMute,
  onSolo,
}: StripProps) {
  return (
    <div
      className={[
        "flex w-20 flex-shrink-0 flex-col items-center gap-2 rounded-lg border bg-ink-50/30 px-2 py-3",
        isMaster ? "border-accent-300 bg-accent-50/30" : "border-ink-200",
        dimmed ? "opacity-50" : "",
      ].join(" ")}
    >
      <span
        className={[
          "h-8 text-center text-[11px] font-semibold leading-tight",
          isMaster ? "text-accent-700" : "text-ink-700",
        ].join(" ")}
        title={label}
      >
        {label}
      </span>
      {/* 縦フェーダー: range を回転させて縦向きにする */}
      <div className="relative flex h-32 w-full items-center justify-center">
        <input
          type="range"
          min={MIN_DB}
          max={MAX_DB}
          step={0.5}
          value={volumeDb}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
          className="h-32 w-32 -rotate-90 cursor-pointer accent-accent-500"
          style={{ writingMode: "vertical-lr" as const }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-ink-600">
        {volumeDb <= MIN_DB ? "−∞" : `${volumeDb > 0 ? "+" : ""}${volumeDb.toFixed(1)} dB`}
      </span>
      <div className="flex w-full gap-1">
        <button
          type="button"
          onClick={() => onMute(!muted)}
          className={[
            "flex-1 rounded-md px-1 py-0.5 text-[10px] font-bold transition",
            muted
              ? "bg-red-500 text-white"
              : "bg-ink-100 text-ink-600 hover:bg-ink-200",
          ].join(" ")}
          title="ミュート"
        >
          M
        </button>
        {!isMaster && onSolo && (
          <button
            type="button"
            onClick={() => onSolo(!soloed)}
            className={[
              "flex-1 rounded-md px-1 py-0.5 text-[10px] font-bold transition",
              soloed
                ? "bg-yellow-400 text-ink-900"
                : "bg-ink-100 text-ink-600 hover:bg-ink-200",
            ].join(" ")}
            title="ソロ (このチャネルだけ鳴らす)"
          >
            S
          </button>
        )}
      </div>
    </div>
  );
}
