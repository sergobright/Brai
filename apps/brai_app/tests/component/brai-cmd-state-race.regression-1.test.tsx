import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { braiCmdSettingsSnapshot, cmdPlugin, openProfileMenuItem, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";

// Regression: ISSUE-010 — медленный начальный снимок перезаписывал более свежее native-событие.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("Brai CMD native snapshot race", () => {
  setupBraiAppTest();

  it("keeps a stateChanged snapshot when the initial read finishes later", async () => {
    stubAndroidCapacitor();
    const listenerReady = deferred<{ remove: () => Promise<void> }>();
    const initialRead = deferred<ReturnType<typeof braiCmdSettingsSnapshot>>();
    cmdPlugin.addListener.mockImplementation((eventName) =>
      eventName === "stateChanged"
        ? listenerReady.promise
        : Promise.resolve({ remove: vi.fn(async () => undefined) }),
    );
    cmdPlugin.getSettings.mockReturnValueOnce(initialRead.promise);
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    await waitFor(() => expect(cmdPlugin.addListener).toHaveBeenCalledWith("stateChanged", expect.any(Function)));
    expect(cmdPlugin.getSettings).not.toHaveBeenCalled();

    await act(async () => {
      listenerReady.resolve({ remove: vi.fn(async () => undefined) });
      await listenerReady.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(cmdPlugin.getSettings).toHaveBeenCalledTimes(1));

    const fresh = braiCmdSettingsSnapshot();
    fresh.settings.mainDictationEnabled = false;
    const listener = cmdPlugin.addListener.mock.calls.find(([eventName]) => eventName === "stateChanged")?.[1] as ((value: typeof fresh) => void);
    act(() => listener(fresh));
    expect(await screen.findByRole("switch", { name: "Главная кнопка включена" })).not.toBeChecked();

    const stale = braiCmdSettingsSnapshot();
    stale.settings.mainDictationEnabled = true;
    await act(async () => initialRead.resolve(stale));

    expect(screen.getByRole("switch", { name: "Главная кнопка включена" })).not.toBeChecked();
  });
});
