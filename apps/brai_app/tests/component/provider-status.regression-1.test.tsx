import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openProfileMenuItem, selectBraiCmdGroup, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";

// Regression: ISSUE-007 — успешная проверка ключа ошибочно называлась завершённым подключением.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
describe("Brai CMD provider status", () => {
  setupBraiAppTest();

  it("shows verification before model selection and connection only after save", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    await selectBraiCmdGroup("Распознавание");
    const speechCard = (await screen.findByText("Распознавание речи")).closest("[data-slot=card]") as HTMLElement;
    fireEvent.click(speechCard.querySelector("button")!);
    fireEvent.click(screen.getByText("Свой API-ключ"));
    fireEvent.change(screen.getByLabelText("API ключ"), { target: { value: "valid-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить подключение" }));

    expect(await screen.findByText("Проверка пройдена")).toBeInTheDocument();
    expect(screen.queryByText("Подключено")).not.toBeInTheDocument();

    const model = screen.getByRole("combobox", { name: "Модель" });
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "test-model" }));
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));

    expect((await screen.findAllByText("Подключено")).length).toBeGreaterThan(0);
  });
});
