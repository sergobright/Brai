import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SectionId } from "@/features/app/appModel";
import { ContextualRail, useContextualRail } from "@/features/app/navigation/ContextualRail";
import { setupBraiAppTest } from "./app-test-support";

function RailHarness({ section }: { section: SectionId }) {
  const rail = useContextualRail(section, "test-user");
  return (
    <>
      <button type="button" onClick={() => rail.setOpen(!rail.open)}>Переключить</button>
      {rail.supported ? (
        <ContextualRail open={rail.open} width={rail.width} onWidth={rail.setWidth}>
          {section}
        </ContextualRail>
      ) : null}
    </>
  );
}

describe("contextual rail", () => {
  setupBraiAppTest();

  it("stores open state separately for each page", async () => {
    const view = render(<RailHarness section="actions" />);
    await waitFor(() => expect(screen.getByLabelText("Контекстная панель")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Переключить" }));
    expect(screen.queryByLabelText("Контекстная панель")).not.toBeInTheDocument();

    view.rerender(<RailHarness section="inbox" />);
    await waitFor(() => expect(screen.getByLabelText("Контекстная панель")).toBeInTheDocument());

    view.rerender(<RailHarness section="actions" />);
    await waitFor(() => expect(screen.queryByLabelText("Контекстная панель")).not.toBeInTheDocument());
  });

  it("uses a shared account width and supports keyboard resizing", async () => {
    const view = render(<RailHarness section="actions" />);
    const slider = await screen.findByRole("slider", { name: "Изменить ширину контекстной панели" });
    expect(slider).toHaveAttribute("aria-valuenow", "256");
    fireEvent.keyDown(slider, { key: "End" });
    await waitFor(() => expect(slider).toHaveAttribute("aria-valuenow", "512"));

    view.rerender(<RailHarness section="factory" />);
    await waitFor(() => expect(screen.getByRole("slider", { name: "Изменить ширину контекстной панели" })).toHaveAttribute("aria-valuenow", "512"));
  });
});
