import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "@/features/app/AuthPage";

describe("AuthPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/auth");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth/session")) {
        return jsonResponse({ authenticated: false, user: null });
      }
      return Promise.reject(new Error("offline"));
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete window.__BRAI_RUNTIME_CONFIG__;
    window.history.replaceState(null, "", "/");
  });

  it("shows the centered auth form and public home link for anonymous users", async () => {
    render(<AuthPage />);

    expect(await screen.findByRole("textbox", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Получить код" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "На главную" })).toHaveAttribute("href", "https://brai.one/");
    expect(document.querySelector("[data-auth-page]")).toBeInTheDocument();
  });

  it("uses email-only login on preview without requesting an OTP", async () => {
    window.__BRAI_RUNTIME_CONFIG__ = { environment: "preview-a" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth/session")) {
        return jsonResponse({ authenticated: false, user: null });
      }
      if (url.endsWith("/auth/test-email-login")) {
        return jsonResponse({ authenticated: true, user: { id: "primary-user", email: "primary@example.com", name: "Primary" } });
      }
      return Promise.reject(new Error("offline"));
    }));

    render(<AuthPage />);

    const email = await screen.findByRole("textbox", { name: "Email" }, { timeout: 5_000 });
    expect(screen.getByRole("button", { name: "Войти" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Получить код" })).not.toBeInTheDocument();

    fireEvent.change(email, { target: { value: "random@example.test" } });
    const loginButton = screen.getByRole("button", { name: "Войти" });
    await waitFor(() => expect(loginButton).toBeEnabled());
    fireEvent.click(loginButton);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/auth/test-email-login",
      expect.objectContaining({ method: "POST" }),
    ), { timeout: 5_000 });
    expect(fetch).not.toHaveBeenCalledWith("/api/auth/otp/send", expect.anything());
    expect(window.location.pathname).toBe("/");
  });

  it("redirects authenticated users to the cabinet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "test-user", email: "test@example.com", name: "Test" } });
      }
      return Promise.reject(new Error("offline"));
    }));

    render(<AuthPage />);

    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
