import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AirWhisperSection } from "@/features/app/sections/airwhisper/AirWhisperSection";

const airWhisper = vi.hoisted(() => ({
  getAirWhisperState: vi.fn(),
  openAirWhisperAccessibilitySettings: vi.fn(),
  openAirWhisperOverlaySettings: vi.fn(),
  openAirWhisperSettings: vi.fn(),
  requestAirWhisperMicrophone: vi.fn(),
  requestAirWhisperNotifications: vi.fn(),
}));

vi.mock("@/shared/platform/airwhisper", () => airWhisper);

describe("AirWhisperSection", () => {
  beforeEach(() => {
    airWhisper.getAirWhisperState.mockResolvedValue({
      native: true,
      settingsDeclared: true,
      accessibilityServiceDeclared: true,
      accessibilityServiceEnabled: false,
      recordingServiceDeclared: true,
      overlayDeclared: true,
      overlayGranted: false,
      microphoneDeclared: true,
      microphoneGranted: false,
      notificationsDeclared: true,
      notificationsGranted: false,
    });
  });

  it("does not show runtime permissions as ready before the user grants them", async () => {
    render(<AirWhisperSection />);

    await waitFor(() => expect(screen.getByText("Нужно включить")).toBeInTheDocument());
    expect(screen.getAllByText("Нужно разрешение")).toHaveLength(3);
    expect(screen.getAllByText("Встроено")).toHaveLength(2);
    expect(screen.queryByText("Готово")).not.toBeInTheDocument();
  });
});
