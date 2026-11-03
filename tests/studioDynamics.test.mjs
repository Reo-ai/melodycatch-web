import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_ATTACK_DB, STUDIO_REFERENCE_DB, studioLayerFor, studioVelocityGain } from '../src/audio/studioDynamics.ts';

const takes = Object.fromEntries(Object.keys(STUDIO_ATTACK_DB).map(key => [key, 2]));
test('all layer boundaries have continuous attack energy, including both takes', () => {
  for (const [dir, levels] of Object.entries(STUDIO_ATTACK_DB)) {
    const n = takes[dir] ?? 1;
    const layers = levels.length / n;
    let previous = -Infinity;
    for (let v = 0.001; v <= 1; v += 0.001) {
      const layer = studioLayerFor(v, layers);
      for (let take = 0; take < n; take++) {
        const file = layer * n + take;
        const actual = levels[file] + 20 * Math.log10(studioVelocityGain(dir, file, v));
        const expected = (STUDIO_REFERENCE_DB[dir] ?? Math.max(...levels)) + 30 * Math.log10(v);
        assert.ok(Math.abs(actual - expected) < 1e-8, `${dir}:${file}`);
        assert.ok(actual >= previous - 1e-8);
        previous = actual;
      }
    }
  }
});
test('zero, negative and invalid velocities are silent', () => {
  for (const v of [0, -1, NaN, Infinity]) assert.equal(studioVelocityGain('kick', 0, v), 0);
});
test('velocity above one is bounded and missing metadata has a safe curve', () => {
  assert.equal(studioVelocityGain('kick', 7, 2), studioVelocityGain('kick', 7, 1));
  assert.equal(studioVelocityGain('unknown', 0, 0.5), Math.pow(0.5, 1.5));
});
