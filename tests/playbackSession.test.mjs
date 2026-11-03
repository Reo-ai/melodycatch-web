import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurePlaybackSession } from '../src/audio/playbackSession.ts';

test('requests playback instead of the silent-switch-sensitive default', () => {
  const nav = { audioSession: { type: 'auto' } };
  configurePlaybackSession(nav);
  assert.equal(nav.audioSession.type, 'playback');
});

test('does not reset an already active playback session', () => {
  configurePlaybackSession({ audioSession: {
    get type() { return 'playback'; },
    set type(_) { assert.fail('must not reset the session'); },
  } });
});

test('browsers without AudioSession continue normally', () => {
  assert.doesNotThrow(() => configurePlaybackSession({}));
});

test('a rejected category does not break playback', () => {
  assert.doesNotThrow(() => configurePlaybackSession({ audioSession: {
    get type() { return 'auto'; },
    set type(_) { throw new Error('unsupported'); },
  } }));
});

test('requests playback again after the browser resets the category', () => {
  const nav = { audioSession: { type: 'auto' } };
  configurePlaybackSession(nav);
  nav.audioSession.type = 'auto';
  configurePlaybackSession(nav);
  assert.equal(nav.audioSession.type, 'playback');
});
