import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSection } from "@/features/app/sections/settings/SettingsSection";
import { BraiApi, type AiModel, type AiProviderCredential, type AiSettings } from "@/shared/api/braiApi";

const OPENAI_PROVIDER: AiProviderCredential = {
  provider_id: "openai",
  key_hint: "1234",
  verified_at_utc: "2026-07-13T10:00:00.000Z",
  updated_at_utc: "2026-07-13T10:00:00.000Z",
  in_use_by: [],
};

describe("account AI settings", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("adds a masked provider key and never persists its plaintext", async () => {
    const state = installAiApiMock();
    renderSettings();

    await screen.findByText("Пока нет подключённых поставщиков.");
    expect(screen.getByRole("switch", { name: "Внешние модели по ключам" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Добавить ключ" }));
    expect(document.querySelector('select[name="provider"]')).toBeInTheDocument();
    expect(screen.getByLabelText("API-ключ")).toHaveAttribute("name", "api_key");
    fireEvent.change(screen.getByLabelText("API-ключ"), { target: { value: "sk-user-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));

    expect(await screen.findByText("•••• 1234")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("sk-user-secret")).not.toBeInTheDocument();
    const storedValues = Array.from({ length: window.localStorage.length }, (_, index) => {
      const key = window.localStorage.key(index);
      return key ? window.localStorage.getItem(key) : null;
    });
    expect(storedValues.join(" ")).not.toContain("sk-user-secret");
    expect(state.fetchMock).toHaveBeenCalledWith(
      "/v1/ai/providers/openai",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ api_key: "sk-user-secret" }) }),
    );
  });

  it("blocks deletion while a provider is assigned", async () => {
    installAiApiMock({ providers: [{ ...OPENAI_PROVIDER, in_use_by: ["text"] }] });
    renderSettings();

    expect(await screen.findByText("•••• 1234")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить" })).toBeDisabled();
    expect(screen.getByText("Сначала переназначьте профиль или выключите внешние модели.")).toBeInTheDocument();
  });

  it("confirms and deletes an unused account key", async () => {
    const state = installAiApiMock({ providers: [OPENAI_PROVIDER] });
    renderSettings();

    await screen.findByText("•••• 1234");
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить ключ" }));

    expect(await screen.findByText("Пока нет подключённых поставщиков.")).toBeInTheDocument();
    expect(state.fetchMock).toHaveBeenCalledWith(
      "/v1/ai/providers/openai",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("enables external mode only after both model profiles are selected", async () => {
    const state = installAiApiMock({ providers: [OPENAI_PROVIDER] });
    renderSettings();

    await screen.findByText("•••• 1234");
    const providerSelects = screen.getAllByLabelText("Поставщик");
    fireEvent.click(providerSelects[0]);
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
    await waitFor(() => expect(screen.getAllByLabelText("Модель")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByLabelText("Модель")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "Text test" }));

    fireEvent.click(screen.getAllByLabelText("Поставщик")[1]);
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
    await waitFor(() => expect(screen.getAllByLabelText("Модель")[1]).toBeEnabled());
    fireEvent.click(screen.getAllByLabelText("Модель")[1]);
    fireEvent.click(await screen.findByRole("option", { name: "Vision test" }));

    const mode = screen.getByRole("switch", { name: "Внешние модели по ключам" });
    await waitFor(() => expect(mode).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(mode);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить модели" }));

    await waitFor(() => expect(state.settings.model_provider_mode).toBe("external"));
    expect(state.settings).toEqual({
      model_provider_mode: "external",
      text: { provider_id: "openai", model: "text-model" },
      vision: { provider_id: "openai", model: "vision-model" },
    });
  });

  it("keeps saved profiles editable before external mode is enabled", async () => {
    const state = installAiApiMock({ providers: [OPENAI_PROVIDER] });
    renderSettings();

    await screen.findByText("•••• 1234");
    const providerSelects = screen.getAllByLabelText("Поставщик");
    fireEvent.click(providerSelects[0]);
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
    await waitFor(() => expect(screen.getAllByLabelText("Модель")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByLabelText("Модель")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "Text test" }));

    fireEvent.click(providerSelects[1]);
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
    await waitFor(() => expect(screen.getAllByLabelText("Модель")[1]).toBeEnabled());
    fireEvent.click(screen.getAllByLabelText("Модель")[1]);
    fireEvent.click(await screen.findByRole("option", { name: "Vision test" }));

    fireEvent.click(screen.getByRole("button", { name: "Сохранить модели" }));

    await waitFor(() => expect(state.settings).toEqual({
      model_provider_mode: "internal",
      text: { provider_id: "openai", model: "text-model" },
      vision: { provider_id: "openai", model: "vision-model" },
    }));
    expect(screen.getAllByLabelText("Модель")[0]).toHaveTextContent("Text test");
    expect(screen.getAllByLabelText("Модель")[1]).toHaveTextContent("Vision test");
    expect(screen.getAllByLabelText("Модель")[0]).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Внешние модели по ключам" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("renders long model lists in the shared scrollable select viewport", async () => {
    installAiApiMock({
      providers: [OPENAI_PROVIDER],
      textModels: Array.from({ length: 80 }, (_, index) => ({
        id: `text-model-${index}`,
        name: `Text model ${index}`,
        capabilities: ["text"],
      })),
    });
    renderSettings();

    await screen.findByText("•••• 1234");
    fireEvent.click(screen.getAllByLabelText("Поставщик")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
    await waitFor(() => expect(screen.getAllByLabelText("Модель")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByLabelText("Модель")[0]);

    const listbox = await screen.findByRole("listbox");
    const viewport = listbox.querySelector('[data-slot="select-viewport"]');
    expect(viewport).toHaveClass("max-h-72", "overflow-y-auto", "overscroll-contain", "touch-pan-y");
    expect(listbox).toHaveClass("overflow-hidden");
    expect(screen.getAllByRole("option")).toHaveLength(80);
  });

  it("retries account metadata loading without reloading the app", async () => {
    const state = installAiApiMock({ failFirstSettingsLoad: true });
    renderSettings();

    expect(await screen.findByText("Не удалось загрузить настройки моделей.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText("Пока нет подключённых поставщиков.")).toBeInTheDocument();
    expect(state.settingsReads).toBe(2);
  });

  it("retries a failed provider model request", async () => {
    const state = installAiApiMock({ providers: [OPENAI_PROVIDER], failFirstTextModelsLoad: true });
    renderSettings();

    await screen.findByText("•••• 1234");
    fireEvent.click(screen.getAllByLabelText("Поставщик")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
    expect(await screen.findByText("Не удалось загрузить модели.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    await waitFor(() => expect(screen.getAllByLabelText("Модель")[0]).toBeEnabled());
    expect(state.textModelReads).toBe(2);
  });

  it("reloads bound models after replacing a provider key", async () => {
    const settings: AiSettings = {
      model_provider_mode: "external",
      text: { provider_id: "openai", model: "text-model" },
      vision: { provider_id: "openai", model: "vision-model" },
    };
    const state = installAiApiMock({
      providers: [{ ...OPENAI_PROVIDER, in_use_by: ["text", "vision"] }],
      settings,
      rotateTextModelNameOnSave: true,
    });
    renderSettings();

    expect(await screen.findByText("Text before replace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Заменить" }));
    fireEvent.change(screen.getByLabelText("API-ключ"), { target: { value: "sk-replacement-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));

    expect(await screen.findByText("Text after replace")).toBeInTheDocument();
    expect(state.textModelReads).toBeGreaterThanOrEqual(2);
  });
});

function renderSettings() {
  render(
    <SettingsSection
      settings={{ display_timezone: "Europe/Moscow" }}
      api={new BraiApi("")}
      busy={false}
      onUpdate={vi.fn(async () => undefined)}
    />,
  );
}

function installAiApiMock(options: {
  providers?: AiProviderCredential[];
  failFirstSettingsLoad?: boolean;
  failFirstTextModelsLoad?: boolean;
  rotateTextModelNameOnSave?: boolean;
  settings?: AiSettings;
  textModels?: AiModel[];
} = {}) {
  const state: {
    providers: AiProviderCredential[];
    settings: AiSettings;
    settingsReads: number;
    textModelReads: number;
    providerSaves: number;
    fetchMock: ReturnType<typeof vi.fn>;
  } = {
    providers: options.providers ?? [],
    settings: options.settings ?? { model_provider_mode: "internal", text: null, vision: null },
    settingsReads: 0,
    textModelReads: 0,
    providerSaves: 0,
    fetchMock: vi.fn(),
  };

  state.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/v1/ai/settings" && method === "GET") {
      state.settingsReads += 1;
      if (options.failFirstSettingsLoad && state.settingsReads === 1) return jsonResponse({ error: "unavailable" }, 503);
      return jsonResponse(state.settings);
    }
    if (url === "/v1/ai/settings" && method === "PATCH") {
      state.settings = { ...state.settings, ...JSON.parse(String(init?.body)) as AiSettings };
      state.providers = state.providers.map((provider) => ({
        ...provider,
        in_use_by: state.settings.model_provider_mode === "external"
          ? ([state.settings.text, state.settings.vision]
              .filter((profile) => profile?.provider_id === provider.provider_id)
              .map((_, index) => index === 0 ? "text" : "vision"))
          : [],
      }));
      return jsonResponse(state.settings);
    }
    if (url === "/v1/ai/providers" && method === "GET") return jsonResponse({ providers: state.providers });
    if (url === "/v1/ai/providers/openai" && method === "PUT") {
      state.providerSaves += 1;
      state.providers = [{
        ...OPENAI_PROVIDER,
        updated_at_utc: `2026-07-13T10:00:0${state.providerSaves}.000Z`,
        in_use_by: state.providers[0]?.in_use_by ?? [],
      }];
      return jsonResponse(state.providers[0]);
    }
    if (url === "/v1/ai/providers/openai" && method === "DELETE") {
      state.providers = [];
      return jsonResponse({ ok: true });
    }
    if (url.endsWith("/models?capability=text")) {
      state.textModelReads += 1;
      if (options.failFirstTextModelsLoad && state.textModelReads === 1) {
        return jsonResponse({ error: "unavailable" }, 503);
      }
      const name = options.rotateTextModelNameOnSave
        ? state.providerSaves > 0 ? "Text after replace" : "Text before replace"
        : "Text test";
      return jsonResponse({ models: options.textModels ?? [{ id: "text-model", name, capabilities: ["text"] }] });
    }
    if (url.endsWith("/models?capability=vision")) {
      return jsonResponse({ models: [{ id: "vision-model", name: "Vision test", capabilities: ["vision"] }] });
    }
    return jsonResponse({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", state.fetchMock);
  return state;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
