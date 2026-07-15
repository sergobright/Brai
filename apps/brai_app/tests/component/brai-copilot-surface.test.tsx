import type { ComponentType, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BraiCopilotSurface } from "@/features/app/sections/brai/BraiCopilotSurface";

type FakeMessage = { id: string; role: "user" | "assistant"; content: string };
type FakeAttachment = { id: string; status: "uploading" | "ready"; metadata?: Record<string, unknown> };
type FakeViewProps = {
  attachments?: FakeAttachment[];
  input?: {
    addMenuButton?: Record<string, unknown>;
    sendButton?: Record<string, unknown>;
    textArea?: Record<string, unknown>;
  };
  isRunning?: boolean;
  messages?: FakeMessage[];
  messageView?: { assistantMessage?: ComponentType<FakeAssistantProps> };
  onInputChange?: (value: string) => void;
  onRemoveAttachment?: (id: string) => void;
  onSubmitMessage?: (value: string) => void;
};
type FakeAssistantProps = FakeViewProps & { message: FakeMessage; id?: string; onRegenerate?: () => void };
type FakeChatProps = {
  attachments?: Record<string, unknown>;
  chatView: ComponentType<FakeViewProps>;
  messageView?: FakeViewProps["messageView"];
};

const fake = vi.hoisted(() => ({
  agent: {
    isRunning: false,
    messages: [] as FakeMessage[],
    addMessage: vi.fn<(message: FakeMessage) => void>(),
  },
  attachments: [] as FakeAttachment[],
  chatProps: null as FakeChatProps | null,
  finishRun: null as (() => void) | null,
  inputChange: vi.fn(),
  removeAttachment: vi.fn(),
  runAgent: vi.fn(async () => undefined),
  stockSubmit: vi.fn(),
  viewProps: null as FakeViewProps | null,
}));

vi.mock("@copilotkit/react-core/v2", async () => {
  const React = await import("react");

  function FakeView(props: FakeViewProps) {
    fake.viewProps = props;
    const Assistant = props.messageView?.assistantMessage;
    return (
      <div>
        <button type="button" onClick={() => props.onSubmitMessage?.("Уточнение")}>Отправить тест</button>
        {props.attachments?.map((attachment) => <button key={attachment.id} type="button" onClick={() => props.onRemoveAttachment?.(attachment.id)}>Удалить {attachment.id}</button>)}
        {Assistant ? props.messages?.filter((message) => message.role === "assistant").map((message) => (
          <Assistant key={message.id} message={message} messages={props.messages} isRunning={props.isRunning} />
        )) : null}
        <button type="button" onClick={() => fake.finishRun?.()}>Завершить run</button>
      </div>
    );
  }

  function FakeChat(props: FakeChatProps) {
    const [running, setRunning] = React.useState(fake.agent.isRunning);
    fake.chatProps = props;
    fake.agent.isRunning = running;
    fake.finishRun = () => {
      fake.agent.isRunning = false;
      setRunning(false);
    };
    const View = props.chatView;
    return (
      <View
        attachments={fake.attachments}
        isRunning={running}
        messages={[...fake.agent.messages]}
        messageView={props.messageView}
        onInputChange={fake.inputChange}
        onRemoveAttachment={fake.removeAttachment}
        onSubmitMessage={fake.stockSubmit}
      />
    );
  }

  function FakeAssistantMessage(props: FakeAssistantProps) {
    return <div id={props.id}>{props.message.content}{props.onRegenerate ? <button type="button" onClick={props.onRegenerate}>Повторить {props.message.id}</button> : null}</div>;
  }

  function FakeUserMessage(props: { id?: string; message: FakeMessage }) {
    return <div id={props.id}>{props.message.content}</div>;
  }

  return {
    CopilotChat: Object.assign(FakeChat, { View: FakeView }),
    CopilotChatAssistantMessage: FakeAssistantMessage,
    CopilotChatUserMessage: FakeUserMessage,
    CopilotKit: ({ children }: { children: ReactNode }) => children,
    UseAgentUpdate: { OnRunStatusChanged: "OnRunStatusChanged" },
    useAgent: () => ({ agent: fake.agent }),
    useCopilotKit: () => ({ copilotkit: { runAgent: fake.runAgent } }),
  };
});

describe("BraiCopilotSurface", () => {
  beforeEach(() => {
    fake.agent.isRunning = false;
    fake.agent.messages = [];
    fake.agent.addMessage.mockReset();
    fake.agent.addMessage.mockImplementation((message) => fake.agent.messages.push(message));
    fake.attachments = [];
    fake.chatProps = null;
    fake.finishRun = null;
    fake.inputChange.mockReset();
    fake.removeAttachment.mockReset();
    fake.runAgent.mockClear();
    fake.stockSubmit.mockReset();
    fake.viewProps = null;
  });

  it("names the composer controls and fields for assistive technology", () => {
    renderSurface();

    expect(fake.viewProps?.input).toMatchObject({
      addMenuButton: { "aria-label": "Добавить изображение" },
      sendButton: { "aria-label": "Отправить сообщение" },
      textArea: { id: "brai-chat-message", name: "message", "aria-label": "Сообщение Браю" },
    });
  });

  it("steers an active run with one stable optimistic user-message id", async () => {
    fake.agent.isRunning = true;
    const onSteer = vi.fn(async () => undefined);
    renderSurface({ onSteer });

    fireEvent.click(screen.getByRole("button", { name: "Отправить тест" }));

    await waitFor(() => expect(onSteer).toHaveBeenCalledOnce());
    const message = fake.agent.addMessage.mock.calls[0][0];
    expect(message).toMatchObject({ role: "user", content: "Уточнение" });
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(onSteer).toHaveBeenCalledWith(message.id, "Уточнение");
    expect(fake.inputChange).toHaveBeenCalledWith("");
    expect(fake.stockSubmit).not.toHaveBeenCalled();
  });

  it("offers retry only on the last assistant and preserves message history", async () => {
    fake.agent.messages = [
      { id: "user-1", role: "user", content: "Вопрос" },
      { id: "assistant-1", role: "assistant", content: "Старый ответ" },
      { id: "assistant-2", role: "assistant", content: "Последний ответ" },
    ];
    const before = [...fake.agent.messages];
    renderSurface();

    expect(screen.queryByRole("button", { name: "Повторить assistant-1" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить assistant-2" }));

    await waitFor(() => expect(fake.runAgent).toHaveBeenCalledOnce());
    expect(fake.agent.messages).toEqual(before);
  });

  it("exposes an alert retry after an early failure without assigning retry to an older assistant", async () => {
    fake.agent.messages = [
      { id: "user-1", role: "user", content: "Первый вопрос" },
      { id: "assistant-1", role: "assistant", content: "Первый ответ" },
      { id: "user-2", role: "user", content: "Сбойный вопрос" },
    ];
    const onRetryChange = vi.fn<(retry: (() => Promise<void>) | null) => void>();
    renderSurface({ onRetryChange });

    expect(screen.queryByRole("button", { name: "Повторить assistant-1" })).not.toBeInTheDocument();
    await waitFor(() => expect(onRetryChange).toHaveBeenCalledWith(expect.any(Function)));
    const retry = onRetryChange.mock.calls.findLast(([candidate]) => typeof candidate === "function")?.[0];
    expect(retry).toBeTypeOf("function");
    await retry?.();

    expect(fake.runAgent).toHaveBeenCalledOnce();
  });

  it("refreshes after a run transition and releases upload reservations on remove", async () => {
    fake.agent.isRunning = true;
    const onRunFinished = vi.fn();
    const onRunStateChange = vi.fn();
    const onError = vi.fn();
    const onDeleteAttachment = vi.fn(async () => undefined);
    const onUpload = vi.fn(async (file: File) => ({ id: file.name, mediaType: file.type, url: `/private/${file.name}` }));
    const view = renderSurface({ onDeleteAttachment, onError, onRunFinished, onRunStateChange, onUpload });

    await waitFor(() => expect(onRunStateChange).toHaveBeenCalledWith(true));

    const config = fake.chatProps?.attachments as { onUpload: (file: File) => Promise<{ metadata?: Record<string, unknown> }> };
    const uploads = [];
    for (let index = 0; index < 5; index += 1) uploads.push(await config.onUpload(image(`image-${index}.png`, 1)));
    await expect(config.onUpload(image("image-6.png", 1))).rejects.toThrow("attachment_count_limit");
    expect(onError).toHaveBeenCalledWith("К одному сообщению можно прикрепить не больше 5 изображений");

    fake.attachments = [{ id: "upload-0", status: "ready", metadata: uploads[0].metadata }];
    view.rerender(surface({ onDeleteAttachment, onError, onRunFinished, onRunStateChange, onUpload }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить upload-0" }));
    await waitFor(() => expect(onDeleteAttachment).toHaveBeenCalledWith("image-0.png"));
    await expect((fake.chatProps?.attachments as typeof config).onUpload(image("image-6.png", 1))).resolves.toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Завершить run" }));
    await waitFor(() => expect(onRunFinished).toHaveBeenCalledOnce());
    expect(onRunStateChange).toHaveBeenLastCalledWith(false);
  });
});

function renderSurface(overrides: Partial<Parameters<typeof surface>[0]> = {}) {
  return render(surface(overrides));
}

function surface(overrides: {
  onError?: (message: string) => void;
  onDeleteAttachment?: (id: string) => Promise<void>;
  onRetryChange?: (retry: (() => Promise<void>) | null) => void;
  onRunFinished?: () => void;
  onRunStateChange?: (running: boolean) => void;
  onSteer?: (messageId: string, text: string) => Promise<void>;
  onUpload?: (file: File) => Promise<{ id: string; mediaType: string; url: string }>;
} = {}) {
  return (
    <BraiCopilotSurface
      runtimeUrl="/api/v1/brai-chat/runtime"
      threadId="thread-1"
      onDeleteAttachment={overrides.onDeleteAttachment ?? vi.fn(async () => undefined)}
      onError={overrides.onError ?? vi.fn()}
      onRetryChange={overrides.onRetryChange ?? vi.fn()}
      onRunFinished={overrides.onRunFinished ?? vi.fn()}
      onRunStateChange={overrides.onRunStateChange ?? vi.fn()}
      onSteer={overrides.onSteer ?? vi.fn(async () => undefined)}
      onUpload={overrides.onUpload ?? vi.fn(async (file) => ({ id: file.name, mediaType: file.type, url: `/private/${file.name}` }))}
    />
  );
}

function image(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}
