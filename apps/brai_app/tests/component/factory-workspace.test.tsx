import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactorySection } from "@/features/app/sections/factory/FactorySection";
import { BraiApi, type AiLog } from "@/shared/api/braiApi";

const log: AiLog = {
  id: 17,
  agent_id: "factory-test",
  agent_version: "1",
  dt: "2026-07-14T00:00:00.000Z",
  status: "done",
  json_data: { outputs: [{ ref: "result", value: "Готово" }] },
  ai_title: "Явно выбранный лог",
  flow_id: null,
  flow_command: null,
};

describe("Factory workspace", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not auto-select a log after loading and opens details only on click", async () => {
    vi.spyOn(BraiApi.prototype, "aiLogs").mockResolvedValue({ logs: [log] });
    render(<FactorySection onMobileOverlayChange={() => undefined} />);

    const card = await screen.findByRole("button", { name: /Явно выбранный лог/ });
    expect(document.querySelector(".page-panel")).not.toBeInTheDocument();
    expect(document.querySelector(".page-main")).toHaveClass("max-w-3xl");

    fireEvent.click(card);
    await waitFor(() => expect(document.querySelector(".page-workspace")).toHaveClass("has-panel"));
    expect(screen.getByLabelText("Подробности AI log")).toBeInTheDocument();
  });
});
