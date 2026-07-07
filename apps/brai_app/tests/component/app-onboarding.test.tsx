import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setupBraiAppTest } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";

describe("BraiApp onboarding", () => {
  setupBraiAppTest();

  it("shows the commissioning start screen before the normal shell on a fresh install", async () => {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);

    render(<BraiApp />);

    expect(await screen.findByRole("button", { name: "Приступить" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Добавить" })).not.toBeInTheDocument();
  });

  it("moves through the first welcome cards into the path choice", async () => {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Приступить" }));
    expect(screen.getByText("Brai рядом с вашим экраном")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.click(screen.getByRole("button", { name: "Начать" }));

    expect(screen.getByText("Как запускаем Brai?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Начать с начала/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Есть профиль/ })).toBeInTheDocument();
  });

  it("keeps unauthenticated users inside the limited access screen after setup", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected protected request: ${url}`);
    });

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByText("Нужен вход")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Войти" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Настройки Brai CMD" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Добавить" })).not.toBeInTheDocument();
  });
});
