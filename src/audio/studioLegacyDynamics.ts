// Measured from the shipped CC0 samples: decoded stereo, first 100 ms RMS dBFS.
// Compensate recording-level jumps separately from the musical velocity curve.
export const STUDIO_ATTACK_DB: Record<string, readonly number[]> = {
  "clap": [
    -31.3527,
    -30.5365,
    -26.1476,
    -24.5307
  ],
  "crash": [
    -21.9293,
    -16.2913
  ],
  "hh_closed": [
    -55.2333,
    -53.3759,
    -44.918,
    -45.3474,
    -39.4186,
    -39.3155,
    -26.3966,
    -26.1849
  ],
  "hh_open": [
    -42.6758,
    -38.52,
    -22.3792
  ],
  "kick": [
    -36.4122,
    -36.4975,
    -26.5098,
    -25.1564,
    -17.7568,
    -20.1949,
    -8.9975,
    -8.8875
  ],
  "ride": [
    -46.713,
    -32.758,
    -27.2754
  ],
  "rim": [
    -42.4918,
    -32.1177,
    -24.6074,
    -20.7635
  ],
  "snare": [
    -44.1647,
    -35.3218,
    -32.3362,
    -29.3922,
    -24.8808,
    -20.56,
    -16.7895,
    -15.3741
  ],
  "tom_hi": [
    -25.7191,
    -18.3046,
    -14.7261,
    -11.1302
  ],
  "tom_lo": [
    -35.5266,
    -25.0765,
    -18.8978,
    -15.0699
  ]
};

export function studioLayerFor(velocity: number, layers: number): number {
  const v = Number.isFinite(velocity) ? Math.max(0, Math.min(1, velocity)) : 0;
  return Math.max(0, Math.min(layers - 1, Math.round(((v - 0.3) / 0.6) * (layers - 1))));
}

export function studioVelocityGain(dir: string, file: number, velocity: number): number {
  const v = Number.isFinite(velocity) ? Math.max(0, Math.min(1, velocity)) : 0;
  if (v === 0) return 0;
  const levels = STUDIO_ATTACK_DB[dir];
  if (!levels || levels[file] === undefined) return Math.pow(v, 1.5);
  const reference = Math.max(...levels);
  const compensation = Math.pow(10, (reference - levels[file]) / 20);
  return compensation * Math.pow(v, 1.5);
}
