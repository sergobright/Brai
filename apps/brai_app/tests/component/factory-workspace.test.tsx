import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactorySection } from "@/features/app/sections/factory/FactorySection";
import { BraiApi, type AgentCatalogEntry, type AiLog } from "@/shared/api/braiApi";
import { SidebarProvider } from "@/shared/ui/sidebar";

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
const agent: AgentCatalogEntry = {
  id: "factory-test",
  version: "1",
  target: "inbox",
  kind: "runtime",
  status: "inactive",
  enabled: false,
  toggleable: true,
  title: "Тестовый агент",
  summary: "Проверяет Factory",
  trigger_description: "По запросу",
  conditions_description: "Только в тесте",
  input_description: "Вход",
  output_description: "Выход",
  interactions_description: "AI_logs",
  side_effects_description: "Нет",
  llm_provider: "codex",
  llm_model: "Luna",
  llm_timeout_ms: 60_000,
  fallback_description: "Нет",
  source_module: "test",
  prompt_version: "1",
  schema_version: "1",
  task_queue_base: "",
  runtime_service: "test-agent",
  metadata_json: { user_toggleable: true },
  updated_at_utc: "2026-07-14T00:00:00.000Z",
};

describe("Factory workspace", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not auto-select a log after loading and opens details only on click", async () => {
    vi.spyOn(BraiApi.prototype, "aiLogs").mockResolvedValue({ logs: [log] });
    vi.spyOn(BraiApi.prototype, "agents").mockResolvedValue({ agents: [agent], can_manage_agents: true });
    render(<FactorySection onMobileOverlayChange={() => undefined} />);

    const card = await screen.findByRole("button", { name: /Явно выбранный лог/ });
    expect(document.querySelector(".page-panel")).not.toBeInTheDocument();
    expect(document.querySelector(".page-main")).toHaveClass("max-w-3xl");

    fireEvent.click(card);
    await waitFor(() => expect(document.querySelector(".page-workspace")).toHaveClass("has-panel"));
    expect(screen.getByLabelText("Подробности AI log")).toBeInTheDocument();
  });

  it("registers the Factory rail and lets only a managing account toggle global status", async () => {
    vi.spyOn(BraiApi.prototype, "aiLogs").mockResolvedValue({ logs: [log] });
    vi.spyOn(BraiApi.prototype, "agents").mockResolvedValue({ agents: [agent], can_manage_agents: true });
    const setEnabled = vi.spyOn(BraiApi.prototype, "setAgentEnabled").mockResolvedValue({
      agent: { ...agent, status: "active", enabled: true },
    });
    const onRailContent = vi.fn();
    render(<FactorySection onMobileOverlayChange={() => undefined} onRailContent={onRailContent} />);

    await waitFor(() => expect(onRailContent).toHaveBeenCalled());
    const rail = onRailContent.mock.calls.findLast(([content]) => content)?.[0];
    render(<SidebarProvider open={false}>{rail}</SidebarProvider>);
    expect(screen.getByRole("button", { name: /Поток/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Тестовый агент/ }));
    expect(await screen.findByRole("heading", { name: "Тестовый агент" })).toBeInTheDocument();
    expect(screen.getByText("Проверяет Factory")).toBeInTheDocument();
    expect(screen.getByText("По запросу")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Включить агента Тестовый агент" }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith("factory-test", true));
  });

  it("shows global agent status without a toggle for a non-primary account", async () => {
    vi.spyOn(BraiApi.prototype, "aiLogs").mockResolvedValue({ logs: [log] });
    vi.spyOn(BraiApi.prototype, "agents").mockResolvedValue({
      agents: [{ ...agent, status: "active", enabled: true }],
      can_manage_agents: false,
    });
    const onRailContent = vi.fn();
    render(<FactorySection onMobileOverlayChange={() => undefined} onRailContent={onRailContent} />);

    await waitFor(() => expect(onRailContent).toHaveBeenCalled());
    const rail = onRailContent.mock.calls.findLast(([content]) => content)?.[0];
    render(<SidebarProvider open={false}>{rail}</SidebarProvider>);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Включён")).toBeInTheDocument();
  });
});
