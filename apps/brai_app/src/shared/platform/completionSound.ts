const COMPLETION_SOUND_URL = "/sounds/brai_sound_done.mp3";

/** Starts feedback only from a direct user gesture. Playback failures are non-fatal. */
export function playCompletionSound(): void {
  if (typeof Audio === "undefined") return;
  const audio = new Audio(COMPLETION_SOUND_URL);
  audio.preload = "auto";
  audio.volume = 0.5;
  try {
    const playback = audio.play();
    void playback?.catch?.(() => undefined);
  } catch {
    // Completion must not fail when a browser or WebView blocks playback.
  }
}
