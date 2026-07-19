import type { ButtonHTMLAttributes, ComponentType, CSSProperties, ElementType, ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BraiCopilotSurface, braiReasoningLabel, normalizeLatexDisplayMath } from "@/features/app/sections/brai/BraiCopilotSurface";

type FakeMessage = { id: string; role: "user" | "assistant"; content: string };
type FakeAttachment = { id: string; status: "uploading" | "ready"; metadata?: Record<string, unknown> };
type FakeInputProps = {
  addMenuButton?: ElementType<ButtonHTMLAttributes<HTMLButtonElement> & { onAddFile?: () => void }>;
  bottomAnchored?: boolean;
  children?: (slots: { addMenuButton: ReactNode; sendButton: ReactNode; textArea: ReactNode }) => ReactNode;
  isRunning?: boolean;
  keyboardHeight?: number;
  onAddFile?: () => void;
  onChange?: (value: string) => void;
  onSubmitMessage?: (value: string) => void;
  sendButton?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
  showDisclaimer?: boolean;
  textArea?: ElementType<Record<string, unknown>>;
  value?: string;
};
type FakeViewProps = {
  autoScroll?: "pin-to-bottom" | "pin-to-send" | "none" | boolean;
  attachments?: FakeAttachment[];
  input?: ComponentType<FakeInputProps> | {
    addMenuButton?: ElementType<ButtonHTMLAttributes<HTMLButtonElement> & { onAddFile?: () => void }>;
    sendButton?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
    textArea?: ElementType<Record<string, unknown>>;
  };
  isRunning?: boolean;
  inputValue?: string;
  messages?: FakeMessage[];
  messageView?: {
    assistantMessage?: ComponentType<FakeAssistantProps>;
    reasoningMessage?: ComponentType<Record<string, unknown>>;
    userMessage?: ComponentType<FakeUserProps>;
  };
  onInputChange?: (value: string) => void;
  onRemoveAttachment?: (id: string) => void;
  onSubmitMessage?: (value: string) => void;
  scrollView?: ElementType<{ children?: ReactNode }>;
};
type FakeAssistantProps = FakeViewProps & {
  message: FakeMessage;
  copyButton?: { className?: string };
  id?: string;
  markdownRenderer?: ComponentType<{ content: string; className?: string }>;
  onRegenerate?: () => void;
  regenerateButton?: { className?: string };
  toolbar?: { className?: string };
};
type FakeUserProps = {
  className?: string;
  id?: string;
  message: FakeMessage;
  toolbar?: { className?: string };
};
type FakeChatProps = {
  attachments?: Record<string, unknown>;
  chatView: ComponentType<FakeViewProps>;
  messageView?: FakeViewProps["messageView"];
  style?: CSSProperties & Record<`--${string}`, string>;
};
type FakeCopilotKitProps = {
  children?: ReactNode;
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
};

const fake = vi.hoisted(() => ({
  agent: {
    isRunning: false,
    messages: [] as FakeMessage[],
    addMessage: vi.fn<(message: FakeMessage) => void>(),
  },
  assistantProps: [] as FakeAssistantProps[],
  attachments: [] as FakeAttachment[],
  chatProps: null as FakeChatProps | null,
  copilotKitProps: null as FakeCopilotKitProps | null,
  configureSuggestions: vi.fn(),
  defaultRenderTool: vi.fn(),
  finishRun: null as (() => void) | null,
  inputChange: vi.fn(),
  inputProps: null as FakeInputProps | null,
  markdownRendererTypes: [] as Array<FakeAssistantProps["markdownRenderer"]>,
  removeAttachment: vi.fn(),
  runAgent: vi.fn(async () => undefined),
  stockSubmit: vi.fn(),
  viewProps: null as FakeViewProps | null,
  userProps: [] as FakeUserProps[],
}));

vi.mock("@copilotkit/react-core/v2", async () => {
  const React = await import("react");

  function FakeView(props: FakeViewProps) {
    fake.viewProps = props;
    const Assistant = props.messageView?.assistantMessage;
    const User = props.messageView?.userMessage;
    const Input = typeof props.input === "function" ? props.input : null;
    const inputConfig = typeof props.input === "object" ? props.input : null;
    const AddMenuButton = inputConfig?.addMenuButton;
    const SendButton = inputConfig?.sendButton;
    const ScrollView = props.scrollView;
    const TextArea = inputConfig?.textArea;
    return (
      <div>
        {Input ? (
          <Input
            isRunning={props.isRunning}
            onAddFile={() => undefined}
            onChange={props.onInputChange}
            onSubmitMessage={props.onSubmitMessage}
            value={props.inputValue}
          />
        ) : null}
        {AddMenuButton ? <AddMenuButton onAddFile={() => undefined} /> : null}
        {TextArea ? <TextArea value={props.inputValue ?? ""} onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => props.onInputChange?.(event.target.value)} /> : null}
        {SendButton ? <SendButton /> : null}
        {ScrollView ? <ScrollView><span>История</span></ScrollView> : null}
        <button type="button" onClick={() => props.onSubmitMessage?.(props.inputValue || "Уточнение")}>Отправить тест</button>
        {props.attachments?.map((attachment) => <button key={attachment.id} type="button" onClick={() => props.onRemoveAttachment?.(attachment.id)}>Удалить {attachment.id}</button>)}
        {Assistant ? props.messages?.filter((message) => message.role === "assistant").map((message) => (
          <Assistant key={message.id} message={message} messages={props.messages} isRunning={props.isRunning} />
        )) : null}
        {User ? props.messages?.filter((message) => message.role === "user").map((message) => (
          <User key={message.id} message={message} />
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
    fake.assistantProps.push(props);
    const MarkdownRenderer = props.markdownRenderer;
    fake.markdownRendererTypes.push(MarkdownRenderer);
    return (
      <div id={props.id}>
        {MarkdownRenderer ? <MarkdownRenderer content={props.message.content} /> : props.message.content}
        {props.onRegenerate ? <button type="button" onClick={props.onRegenerate}>Повторить {props.message.id}</button> : null}
      </div>
    );
  }

  function FakeMarkdownRenderer({ content, className }: { content: string; className?: string }) {
    return <span className={className}>{content}</span>;
  }

  function FakeUserMessage(props: FakeUserProps) {
    fake.userProps.push(props);
    return <div id={props.id}>{props.message.content}</div>;
  }

  function FakeReasoningMessage() {
    return <div>Reasoning</div>;
  }

  function FakeDefaultScrollView({ children, scrollToBottomButton: ScrollToBottomButton }: {
    children?: ReactNode;
    scrollToBottomButton?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
  }) {
    return (
      <div data-testid="copilot-default-scroll-view">
        {children}
        {ScrollToBottomButton ? <ScrollToBottomButton /> : null}
      </div>
    );
  }

  const FakeViewWithSlots = Object.assign(FakeView, {
    ScrollToBottomButton: () => null,
    ScrollView: FakeDefaultScrollView,
  });

  function FakeInput(props: FakeInputProps) {
    fake.inputProps = props;
    const AddMenuButton = props.addMenuButton;
    const SendButton = props.sendButton;
    const TextArea = props.textArea;
    const slots = {
      addMenuButton: AddMenuButton ? <AddMenuButton onAddFile={props.onAddFile} /> : null,
      sendButton: SendButton ? <SendButton onClick={() => props.onSubmitMessage?.(props.value ?? "")} /> : null,
      textArea: TextArea ? (
        <TextArea
          value={props.value ?? ""}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange?.(event.target.value)}
          onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && !event.shiftKey) props.onSubmitMessage?.(props.value ?? "Сообщение");
          }}
        />
      ) : null,
    };
    return <>{props.children?.(slots)}</>;
  }

  return {
    CopilotChat: Object.assign(FakeChat, { View: FakeViewWithSlots }),
    CopilotChatAssistantMessage: Object.assign(FakeAssistantMessage, { MarkdownRenderer: FakeMarkdownRenderer }),
    CopilotChatInput: Object.assign(FakeInput, { SendButton: () => null }),
    CopilotChatReasoningMessage: FakeReasoningMessage,
    CopilotChatUserMessage: FakeUserMessage,
    CopilotKit: (props: FakeCopilotKitProps) => {
      fake.copilotKitProps = props;
      return props.children;
    },
    UseAgentUpdate: { OnRunStatusChanged: "OnRunStatusChanged" },
    useAgent: () => ({ agent: fake.agent }),
    useConfigureSuggestions: fake.configureSuggestions,
    useCopilotKit: () => ({ copilotkit: { runAgent: fake.runAgent } }),
    useDefaultRenderTool: fake.defaultRenderTool,
  };
});

describe("BraiCopilotSurface", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    window.localStorage.clear();
    fake.agent.isRunning = false;
    fake.agent.messages = [];
    fake.agent.addMessage.mockReset();
    fake.agent.addMessage.mockImplementation((message) => fake.agent.messages.push(message));
    fake.assistantProps = [];
    fake.attachments = [];
    fake.chatProps = null;
    fake.copilotKitProps = null;
    fake.configureSuggestions.mockReset();
    fake.defaultRenderTool.mockReset();
    fake.finishRun = null;
    fake.inputChange.mockReset();
    fake.inputProps = null;
    fake.markdownRendererTypes = [];
    fake.removeAttachment.mockReset();
    fake.runAgent.mockClear();
    fake.stockSubmit.mockReset();
    fake.viewProps = null;
    fake.userProps = [];
  });

  it("names the composer controls and fields for assistive technology", () => {
    renderSurface();

    expect(screen.getByRole("button", { name: "Добавить изображение" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение Браю" })).toHaveAttribute("id", "brai-chat-message");
    expect(screen.getByRole("textbox", { name: "Сообщение Браю" })).toHaveAttribute("name", "message");
    expect(screen.getByRole("textbox", { name: "Сообщение Браю" })).toHaveAttribute("data-slot", "textarea");
    expect(screen.getByRole("textbox", { name: "Сообщение Браю" })).toHaveAttribute("placeholder", "Напишите Браю…");
    expect(screen.getByRole("button", { name: "Отправить сообщение" })).toBeInTheDocument();
  });

  it("sends the native Better Auth bearer token to every CopilotKit runtime request", () => {
    renderSurface({ runtimeBearerToken: "signed.native.session" });

    expect(fake.copilotKitProps?.credentials).toBe("include");
    expect(fake.copilotKitProps?.headers).toMatchObject({
      Authorization: "Bearer signed.native.session",
      "x-brai-chat-replay-mode": "full",
    });
  });

  it("keeps runtime headers stable across visual viewport rerenders", () => {
    const headers = { "x-brai-chat-replay-mode": "full" };
    const view = render(surface({ headers }));
    const firstRuntimeHeaders = fake.copilotKitProps?.headers;

    view.rerender(surface({ headers }));

    expect(fake.copilotKitProps?.headers).toBe(firstRuntimeHeaders);
  });

  it("keeps the stock chat while inheriting every semantic Brai theme token", () => {
    const { container } = renderSurface();

    expect(container.querySelector(".dark")).toBeInTheDocument();
    expect(fake.chatProps?.style).toMatchObject({
      "--background": "var(--brai-copilot-background)",
      "--foreground": "var(--brai-copilot-foreground)",
      "--card": "var(--brai-copilot-background)",
      "--cpk-color-gray-900": "var(--brai-copilot-foreground)",
      "--cpk-color-zinc-900": "var(--brai-copilot-foreground)",
      "--primary": "var(--brai-copilot-primary)",
      "--border": "var(--brai-copilot-border)",
      "--cpk-default-font-family": "var(--font-app-sans)",
    });
    expect(Object.values(fake.chatProps?.style ?? {})).not.toContain("inherit");
    expect(container.querySelector<HTMLElement>(".brai-copilot-surface")?.style.getPropertyValue("--brai-copilot-background")).toBe("var(--background)");
    expect(fake.configureSuggestions).not.toHaveBeenCalled();
    expect(fake.defaultRenderTool).toHaveBeenCalledOnce();
    expect(fake.chatProps?.labels).toMatchObject({ welcomeMessageText: "", chatDisclaimerText: "" });
    expect(fake.chatProps?.messageView?.reasoningMessage).toBeTypeOf("function");
    expect(fake.viewProps?.input).toBeTypeOf("function");
    expect(fake.inputProps?.addMenuButton).toBeTypeOf("function");
    expect(fake.inputProps?.textArea).toBeTruthy();
    expect(fake.inputProps?.bottomAnchored).toBe(true);
    expect(fake.inputProps?.keyboardHeight).toBeUndefined();
    expect(fake.inputProps?.showDisclaimer).toBe(false);
    expect(fake.viewProps?.autoScroll).toBe("pin-to-bottom");
    expect(screen.getByTestId("copilot-chat-input")).toHaveClass("min-h-0", "bg-background");
    expect(screen.getByRole("textbox", { name: "Сообщение Браю" })).toHaveClass("field-sizing-content", "max-h-[50dvh]", "min-h-6");
    expect(screen.getByRole("textbox", { name: "Сообщение Браю" })).toHaveAttribute("rows", "1");
    expect(fake.viewProps?.scrollView).toBeTypeOf("function");
    expect(screen.getByTestId("copilot-default-scroll-view")).toHaveTextContent("История");
    expect(screen.getByRole("button", { name: "Прокрутить к последнему сообщению" })).toBeInTheDocument();
  });

  it("does not rewrite the textarea height for every typed character", () => {
    renderSurface();

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Сообщение Браю" });
    fireEvent.change(textarea, { target: { value: "тест" } });

    expect(textarea.style.height).toBe("");
  });

  it("keeps the assistant markdown renderer mounted across controlled draft changes", () => {
    fake.agent.messages = [{ id: "assistant-1", role: "assistant", content: "Стабильный ответ" }];
    renderSurface();

    const firstRenderer = fake.markdownRendererTypes.at(-1);
    fireEvent.change(screen.getByRole("textbox", { name: "Сообщение Браю" }), { target: { value: "я" } });

    expect(firstRenderer).toBeTypeOf("function");
    expect(fake.markdownRendererTypes.at(-1)).toBe(firstRenderer);
    expect(screen.getByText("Стабильный ответ")).toBeInTheDocument();
  });

  it("keeps a small user-to-assistant gap and assistant actions tiny and muted", () => {
    fake.agent.messages = [
      { id: "user-1", role: "user", content: "Вопрос" },
      { id: "assistant-1", role: "assistant", content: "Ответ" },
    ];

    renderSurface();

    expect(fake.userProps[0]?.toolbar?.className).toContain("!hidden");
    expect(fake.userProps[0]?.className).toContain("!pt-2");
    expect(fake.assistantProps[0]?.className).toContain("!pt-2");
    expect(fake.assistantProps[0]?.toolbar?.className).toContain("!h-4");
    expect(fake.assistantProps[0]?.copyButton?.className).toContain("opacity-20");
    expect(fake.assistantProps[0]?.copyButton?.className).toContain("!size-4");
    expect(fake.assistantProps[0]?.regenerateButton?.className).toContain("opacity-20");
  });

  it("reserves the compact composer inset before CopilotKit measures the overlay", () => {
    renderSurface();

    expect(fake.chatProps?.className).toContain("brai-chat-stable-composer-inset");
    expect(screen.getByTestId("copilot-chat-input").closest("[data-brai-composer-inset-source]")).not.toBeNull();
  });

  it("steers an active run through the runtime before clearing its draft", async () => {
    fake.agent.isRunning = true;
    const onSteer = vi.fn(async () => undefined);
    renderSurface({ onSteer });

    fireEvent.click(screen.getByRole("button", { name: "Отправить тест" }));

    await waitFor(() => expect(onSteer).toHaveBeenCalledOnce());
    const [messageId, text] = onSteer.mock.calls[0];
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(text).toBe("Уточнение");
    expect(fake.agent.addMessage).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("brai_chat_draft:test")).toBe("");
    expect(fake.stockSubmit).not.toHaveBeenCalled();
  });

  it("keeps the active-run draft when the runtime rejects a turn", async () => {
    window.localStorage.setItem("brai_chat_draft:test", "Уточнение во время ответа");
    fake.agent.isRunning = true;
    const onError = vi.fn();
    const onSteer = vi.fn(async () => { throw new Error("turn_conflict"); });
    renderSurface({ onError, onSteer });

    fireEvent.click(screen.getByRole("button", { name: "Отправить тест" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Сообщение не направлено в активный ответ. Попробуйте ещё раз"));
    expect(fake.agent.addMessage).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("brai_chat_draft:test")).toBe("Уточнение во время ответа");
    expect(fake.stockSubmit).not.toHaveBeenCalled();
  });

  it("submits with Enter on desktop web and keeps Shift+Enter as a newline", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    renderSurface();

    const textarea = screen.getByRole("textbox", { name: "Сообщение Браю" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(fake.stockSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(fake.stockSubmit).toHaveBeenCalledOnce();
  });

  it("keeps mobile Enter as a newline key and normalizes Codex display math for the renderer", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    renderSurface();

    const textarea = screen.getByRole("textbox", { name: "Сообщение Браю" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(fake.stockSubmit).not.toHaveBeenCalled();
    expect(normalizeLatexDisplayMath("\\[\\Delta x \\geq 1\\]")).toBe("$$\n\\Delta x \\geq 1\n$$");
    expect(normalizeLatexDisplayMath("[\\Delta p \\geq 1]")).toBe("$$\n\\Delta p \\geq 1\n$$");
  });

  it("uses a Russian public label for reasoning summaries", () => {
    expect(braiReasoningLabel(true)).toBe("Размышляю…");
    expect(braiReasoningLabel(false)).toBe("Размышлял несколько секунд");
  });

  it("keeps the per-thread draft when send is attempted during an attachment upload", async () => {
    window.localStorage.setItem("brai_chat_draft:test", "Текст не должен исчезнуть");
    fake.attachments = [{ id: "uploading-image", status: "uploading" }];
    const onError = vi.fn();
    renderSurface({ onError });

    expect(screen.getByRole("textbox", { name: "Сообщение Браю" })).toHaveValue("Текст не должен исчезнуть");
    fireEvent.click(screen.getByRole("button", { name: "Отправить тест" }));
    act(() => fake.viewProps?.onInputChange?.(""));

    expect(onError).toHaveBeenCalledWith("Дождитесь загрузки изображений перед отправкой");
    expect(screen.getByRole("textbox", { name: "Сообщение Браю" })).toHaveValue("Текст не должен исчезнуть");
    expect(window.localStorage.getItem("brai_chat_draft:test")).toBe("Текст не должен исчезнуть");
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
    const onError = vi.fn();
    const onDeleteAttachment = vi.fn(async () => undefined);
    const onUpload = vi.fn(async (file: File) => ({ id: file.name, mediaType: file.type, url: `/private/${file.name}` }));
    const view = renderSurface({ onDeleteAttachment, onError, onRunFinished, onUpload });

    const config = fake.chatProps?.attachments as { onUpload: (file: File) => Promise<{ metadata?: Record<string, unknown> }> };
    const uploads = [];
    for (let index = 0; index < 5; index += 1) uploads.push(await config.onUpload(image(`image-${index}.png`, 1)));
    await expect(config.onUpload(image("image-6.png", 1))).rejects.toThrow("attachment_count_limit");
    expect(onError).toHaveBeenCalledWith("К одному сообщению можно прикрепить не больше 5 изображений");

    fake.attachments = [{ id: "upload-0", status: "ready", metadata: uploads[0].metadata }];
    view.rerender(surface({ onDeleteAttachment, onError, onRunFinished, onUpload }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить upload-0" }));
    await waitFor(() => expect(onDeleteAttachment).toHaveBeenCalledWith("image-0.png"));
    await expect((fake.chatProps?.attachments as typeof config).onUpload(image("image-6.png", 1))).resolves.toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Завершить run" }));
    await waitFor(() => expect(onRunFinished).toHaveBeenCalledOnce());
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
  onSteer?: (messageId: string, text: string) => Promise<void>;
  onUpload?: (file: File) => Promise<{ id: string; mediaType: string; url: string }>;
  headers?: Record<string, string>;
  runtimeBearerToken?: string | null;
} = {}) {
  return (
    <BraiCopilotSurface
      runtimeUrl="/api/v1/brai-chat/runtime"
      theme="dark"
      threadId="thread-1"
      headers={overrides.headers ?? { "x-brai-chat-replay-mode": "full" }}
      runtimeBearerToken={overrides.runtimeBearerToken}
      draftStorageKey="brai_chat_draft:test"
      loadAttachment={vi.fn(async () => new Blob([new Uint8Array([0x89])], { type: "image/png" }))}
      onDeleteAttachment={overrides.onDeleteAttachment ?? vi.fn(async () => undefined)}
      onComposerReady={vi.fn()}
      onError={overrides.onError ?? vi.fn()}
      onRetryChange={overrides.onRetryChange ?? vi.fn()}
      onRunFinished={overrides.onRunFinished ?? vi.fn()}
      onSteer={overrides.onSteer ?? vi.fn(async () => undefined)}
      onUpload={overrides.onUpload ?? vi.fn(async (file) => ({ id: file.name, mediaType: file.type, url: `/private/${file.name}` }))}
    />
  );
}

function image(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}
