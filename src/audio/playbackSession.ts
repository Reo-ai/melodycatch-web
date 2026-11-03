type PlaybackNavigator = { audioSession?: { type: string } };

/** Request media playback on Safari, including when the iPhone is silenced.
 * Call synchronously in the user's play/key gesture, before resuming Web Audio.
 * Older browsers may not implement this API; they must still be able to play.
 */
export function configurePlaybackSession(
  nav: PlaybackNavigator = navigator as PlaybackNavigator,
): void {
  try {
    if (nav.audioSession && nav.audioSession.type !== "playback") {
      nav.audioSession.type = "playback";
    }
  } catch {
    // An unsupported session category must not prevent normal audio playback.
  }
}
