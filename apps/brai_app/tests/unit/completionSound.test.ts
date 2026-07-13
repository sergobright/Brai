import { afterEach, describe, expect, it, vi } from "vitest";
import { playCompletionSound } from "@/shared/platform/completionSound";

describe("completion sound", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plays the bundled sound at half volume", () => {
    const play = vi.fn(() => Promise.resolve());
    const AudioMock = vi.fn(function AudioMock(this: { preload: string; volume: number; play: typeof play }) {
      this.preload = "";
      this.volume = 1;
      this.play = play;
    });
    vi.stubGlobal("Audio", AudioMock);

    playCompletionSound();

    expect(AudioMock).toHaveBeenCalledWith("/sounds/brai_sound_done.mp3");
    expect(AudioMock.mock.instances[0]).toMatchObject({ preload: "auto", volume: 0.5 });
    expect(play).toHaveBeenCalledOnce();
  });
});
