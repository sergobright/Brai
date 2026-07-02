import fs from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { openSettingsFromProfile, setupBraiAppTest } from "./app-test-support";
import RootLayout from "@/app/layout";
import { BraiApp } from "@/features/app/BraiApp";

function collectSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    return entry.isFile() ? [fullPath] : [];
  });
}

describe("BraiApp theme", () => {
  setupBraiAppTest();

  it("applies the saved theme before the app hydrates", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main />
      </RootLayout>,
    );
    const bodyIndex = markup.indexOf("<body>");
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(markup);

    expect(markup).toContain('data-theme="dark"');
    expect(scriptMatch?.index).toBeGreaterThan(-1);
    expect(scriptMatch?.index).toBeLessThan(bodyIndex);

    document.documentElement.dataset.theme = "light";
    window.localStorage.setItem("brai_theme_mode", "dark");
    new Function(scriptMatch?.[1] ?? "")();

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ignores retired runtime theme token storage before the app hydrates", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main />
      </RootLayout>,
    );
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(markup);

    window.localStorage.setItem("brai_theme_tokens", JSON.stringify({ primary: "#0f766e" }));
    window.localStorage.setItem("brai_accent_theme", JSON.stringify({ primary: "#7c3aed" }));
    new Function(scriptMatch?.[1] ?? "")();

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("");
  });

  it("toggles the settings theme button through the app theme state", async () => {
    render(<BraiApp />);
    await openSettingsFromProfile();

    fireEvent.click(screen.getByRole("button", { name: "Включить темную тему" }));

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(window.localStorage.getItem("brai_theme_mode")).toBe("dark");
    });

    fireEvent.click(screen.getByRole("button", { name: "Включить светлую тему" }));

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(window.localStorage.getItem("brai_theme_mode")).toBe("light");
    });
  });

  it("keeps retired color tokens out of app source", () => {
    const retiredTokenPattern =
      /--(surface|line|ok|warn|danger|primary-ink|primary-soft|shadcn-|success|warning|info|sidebar-)/;
    const matches = collectSourceFiles(path.join(process.cwd(), "src"))
      .filter((filePath) => retiredTokenPattern.test(fs.readFileSync(filePath, "utf8")))
      .map((filePath) => path.relative(process.cwd(), filePath));

    expect(matches).toEqual([]);
  });
});
