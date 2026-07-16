import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileProfileDrawer, requestMobileProfileDrawerClose } from "@/features/app/navigation/MobileProfileDrawer";
import { setupBraiAppTest } from "./app-test-support";

describe("MobileProfileDrawer", () => {
  setupBraiAppTest();

  it("starts with navigation content and closes through the shared selection event", async () => {
    const onClose = vi.fn();
    render(
      <MobileProfileDrawer onClose={onClose}>
        <nav aria-label="Списки действий">Списки</nav>
      </MobileProfileDrawer>,
    );

    const drawer = screen.getByRole("dialog", { name: "Списки действий" });
    expect(screen.queryByRole("button", { name: "Закрыть меню" })).not.toBeInTheDocument();
    expect(drawer.querySelector(":scope > .flex.min-h-11")).not.toBeInTheDocument();
    expect(document.querySelector(".mobile-menu-backdrop")).toBeInTheDocument();

    requestMobileProfileDrawerClose();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
