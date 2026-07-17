import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BraiChatImage } from "@/features/app/sections/brai/BraiChatImage";

describe("BraiChatImage", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:generated-image"),
      revokeObjectURL: vi.fn(),
    }));
  });

  it("opens a generated image directly from its preview in the standard dialog", async () => {
    const loadBlob = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    render(<BraiChatImage attachmentId="generated-1" label="Лиса в малине" loadBlob={loadBlob} />);

    const preview = await screen.findByRole("button", { name: "Открыть изображение: Лиса в малине" });
    fireEvent.click(preview);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img", { name: "Лиса в малине" })).toBeInTheDocument();
    expect(dialog.parentElement).toHaveClass("pt-[max(env(safe-area-inset-top),3.5rem)]");
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть просмотр" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes the full-screen viewer through Android back", async () => {
    const loadBlob = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    render(<BraiChatImage attachmentId="generated-1" label="Лиса в малине" loadBlob={loadBlob} />);

    fireEvent.click(await screen.findByRole("button", { name: "Открыть изображение: Лиса в малине" }));
    await screen.findByRole("dialog");
    window.BraiAndroidBack?.();

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
