# iPhone silent-mode playback regression check

The shared audio gate requests `navigator.audioSession.type = "playback"`
before `Tone.start()`. The keyboard, transport, auto-composer, saved player and
drum pads use this gate. Recording stores note events, not microphone audio.
Every user-initiated start resumes the context, including after interruptions.

Automated checks:

```sh
node --experimental-strip-types --test tests/playbackSession.test.mjs
npm run build
```

On a physical iPhone (not yet verified by the implementation environment):

1. Set media volume above zero and turn silent mode on.
2. Open the production site in Safari. Tap a piano key and start a composition.
3. Check piano, chords, drums, saved-song playback, and recorded-note playback.
4. Switch away and return; tap play/a key again and confirm sound resumes.
5. Repeat with silent mode off and check the existing behavior is unchanged.

AudioSession is feature-detected. Browsers without it retain their existing
behavior; silent-mode playback is not guaranteed there. This does not override
zero media volume, audio routing, or the browser's user-gesture requirement.

References:
- https://developer.mozilla.org/en-US/docs/Web/API/AudioSession/type
- https://bugs.webkit.org/show_bug.cgi?id=251532
