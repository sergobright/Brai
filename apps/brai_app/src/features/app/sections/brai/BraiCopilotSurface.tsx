"use client";

import type { ComponentProps, CSSProperties } from "react";
import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ImageIcon, Plus, Search } from "lucide-react";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatInput,
  CopilotChatReasoningMessage,
  CopilotChatUserMessage,
  CopilotKit,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
  useDefaultRenderTool,
} from "@copilotkit/react-core/v2";
import { Button } from "@/shared/ui/button";
import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import { Textarea } from "@/shared/ui/textarea";
import { cx } from "../../appUtils";
import type { ThemeMode } from "../../appModel";
import { attachmentReservationError } from "./braiChatModel";
import { BraiChatImage } from "./BraiChatImage";

const BRAI_AGENT_ID = "brai-codex";
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
type CopilotThemeStyle = CSSProperties & Record<`--${string}`, string>;

const BRAI_COPILOT_TOKEN_BRIDGE: CopilotThemeStyle = {
  "--brai-copilot-accent": "var(--accent)",
  "--brai-copilot-accent-foreground": "var(--accent-foreground)",
  "--brai-copilot-background": "var(--background)",
  "--brai-copilot-border": "var(--border)",
  "--brai-copilot-card": "var(--card)",
  "--brai-copilot-card-foreground": "var(--card-foreground)",
  "--brai-copilot-destructive": "var(--destructive)",
  "--brai-copilot-destructive-foreground": "var(--destructive-foreground)",
  "--brai-copilot-foreground": "var(--foreground)",
  "--brai-copilot-input": "var(--input)",
  "--brai-copilot-muted": "var(--muted)",
  "--brai-copilot-muted-foreground": "var(--muted-foreground)",
  "--brai-copilot-popover": "var(--popover)",
  "--brai-copilot-popover-foreground": "var(--popover-foreground)",
  "--brai-copilot-primary": "var(--primary)",
  "--brai-copilot-primary-foreground": "var(--primary-foreground)",
  "--brai-copilot-radius": "var(--radius)",
  "--brai-copilot-ring": "var(--ring)",
  "--brai-copilot-secondary": "var(--secondary)",
  "--brai-copilot-secondary-foreground": "var(--secondary-foreground)",
};

const BRAI_COPILOT_THEME: CopilotThemeStyle = {
  "--accent": "var(--brai-copilot-accent)",
  "--accent-foreground": "var(--brai-copilot-accent-foreground)",
  "--background": "var(--brai-copilot-background)",
  "--border": "var(--brai-copilot-border)",
  "--card": "var(--brai-copilot-card)",
  "--card-foreground": "var(--brai-copilot-card-foreground)",
  "--cpk-default-font-family": "var(--font-app-sans)",
  "--cpk-default-mono-font-family": "var(--font-app-mono)",
  "--cpk-color-black": "var(--brai-copilot-foreground)",
  "--cpk-color-gray-100": "var(--brai-copilot-muted)",
  "--cpk-color-gray-200": "var(--brai-copilot-muted)",
  "--cpk-color-gray-400": "var(--brai-copilot-muted-foreground)",
  "--cpk-color-gray-500": "var(--brai-copilot-muted-foreground)",
  "--cpk-color-gray-700": "var(--brai-copilot-border)",
  "--cpk-color-gray-800": "var(--brai-copilot-accent)",
  "--cpk-color-gray-900": "var(--brai-copilot-card)",
  "--cpk-color-white": "var(--brai-copilot-background)",
  "--cpk-color-zinc-100": "var(--brai-copilot-foreground)",
  "--cpk-color-zinc-200": "var(--brai-copilot-foreground)",
  "--cpk-color-zinc-300": "var(--brai-copilot-muted-foreground)",
  "--cpk-color-zinc-400": "var(--brai-copilot-muted-foreground)",
  "--cpk-color-zinc-700": "var(--brai-copilot-accent)",
  "--cpk-color-zinc-800": "var(--brai-copilot-border)",
  "--cpk-color-zinc-900": "var(--brai-copilot-card)",
  "--destructive": "var(--brai-copilot-destructive)",
  "--destructive-foreground": "var(--brai-copilot-destructive-foreground)",
  "--foreground": "var(--brai-copilot-foreground)",
  "--input": "var(--brai-copilot-input)",
  "--muted": "var(--brai-copilot-muted)",
  "--muted-foreground": "var(--brai-copilot-muted-foreground)",
  "--popover": "var(--brai-copilot-popover)",
  "--popover-foreground": "var(--brai-copilot-popover-foreground)",
  "--primary": "var(--brai-copilot-primary)",
  "--primary-foreground": "var(--brai-copilot-primary-foreground)",
  "--radius": "var(--brai-copilot-radius)",
  "--ring": "var(--brai-copilot-ring)",
  "--secondary": "var(--brai-copilot-secondary)",
  "--secondary-foreground": "var(--brai-copilot-secondary-foreground)",
};

type BraiCopilotContextValue = {
  onError: (message: string, retryable?: boolean) => void;
  onDeleteAttachment: (id: string) => Promise<void>;
  onRetryChange: (retry: (() => Promise<void>) | null) => void;
  onRunFinished: () => void;
  onSteer: (messageId: string, text: string) => Promise<void>;
  releaseReservations: (ids: string[]) => void;
  draft: string;
  setDraft: (value: string) => void;
  loadAttachment: (id: string, download?: boolean) => Promise<Blob>;
};

const BraiCopilotContext = createContext<BraiCopilotContextValue | null>(null);

export function BraiCopilotSurface({
  headers,
  draftStorageKey,
  loadAttachment,
  onError,
  onDeleteAttachment,
  onRetryChange,
  onRunFinished,
  onSteer,
  onUpload,
  runtimeUrl,
  theme,
  threadId,
}: {
  headers?: Record<string, string>;
  draftStorageKey: string;
  loadAttachment: (id: string, download?: boolean) => Promise<Blob>;
  onError: (message: string, retryable?: boolean) => void;
  onDeleteAttachment: (id: string) => Promise<void>;
  onRetryChange: (retry: (() => Promise<void>) | null) => void;
  onRunFinished: () => void;
  onSteer: (messageId: string, text: string) => Promise<void>;
  onUpload: (file: File) => Promise<{ id: string; mediaType: string; url: string }>;
  runtimeUrl: string;
  theme: ThemeMode;
  threadId: string;
}) {
  const reservations = useRef(new Map<string, number>());
  const fileReservations = useRef(new WeakMap<File, string>());
  const [draft, setDraftState] = useState(() => {
    try {
      return getBraiLocalStorageItem(draftStorageKey) ?? "";
    } catch {
      return "";
    }
  });

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    try {
      setBraiLocalStorageItem(draftStorageKey, value);
    } catch {
      // localStorage is optional in constrained WebViews.
    }
  }, [draftStorageKey]);

  const releaseReservations = useCallback((ids: string[]) => {
    for (const id of ids) reservations.current.delete(id);
  }, []);

  const context = useMemo(() => ({
    draft, loadAttachment, onDeleteAttachment, onError, onRetryChange, onRunFinished, onSteer, releaseReservations, setDraft,
  }), [draft, loadAttachment, onDeleteAttachment, onError, onRetryChange, onRunFinished, onSteer, releaseReservations, setDraft]);

  return (
    <CopilotKit
      runtimeUrl={runtimeUrl}
      agent={BRAI_AGENT_ID}
      threadId={threadId}
      credentials="include"
      headers={headers}
      useSingleEndpoint
      enableInspector={false}
      showDevConsole={false}
      onError={() => onError("Брай временно недоступен", true)}
    >
      <BraiCopilotContext.Provider value={context}>
        <BraiDefaultToolRenderer />
        <div
          className={theme === "dark" ? "brai-copilot-surface dark h-full min-h-0" : "brai-copilot-surface h-full min-h-0"}
          style={BRAI_COPILOT_TOKEN_BRIDGE}
        >
          <CopilotChat
            agentId={BRAI_AGENT_ID}
            threadId={threadId}
            className="h-full min-h-0 bg-background text-foreground [&_[data-testid=copilot-chat-input]]:!rounded-2xl [&_[data-testid=copilot-chat-input]]:!border [&_[data-testid=copilot-chat-input]]:!border-border [&_[data-testid=copilot-chat-input]]:!bg-card [&_[data-testid=copilot-chat-input]]:!shadow-sm [&_[data-testid=copilot-chat-textarea]]:!text-foreground [&_[data-testid=copilot-chat-textarea]]:placeholder:!text-muted-foreground [&_[data-testid=copilot-slash-menu]]:!border-border [&_[data-testid=copilot-slash-menu]]:!bg-popover [&_[data-testid=copilot-slash-menu]]:!text-popover-foreground [&_[data-testid=copilot-slash-menu]_[role=option]:hover]:!bg-accent [&_[data-testid=copilot-slash-menu]_[role=option][data-active=true]]:!bg-accent"
            style={BRAI_COPILOT_THEME}
            chatView={BraiChatView}
            labels={{
              chatInputPlaceholder: "Напишите Браю…",
              welcomeMessageText: "",
              chatDisclaimerText: "",
              assistantMessageToolbarRegenerateLabel: "Повторить ответ",
            }}
            messageView={{
              assistantMessage: AnchoredAssistantMessage,
              reasoningMessage: BraiReasoningMessage,
              userMessage: AnchoredUserMessage,
            }}
            attachments={{
              enabled: true,
              accept: "image/jpeg,image/png,image/webp",
              maxSize: MAX_ATTACHMENT_BYTES,
              onUpload: async (file) => {
                const limit = attachmentReservationError(reservations.current.values(), file.size);
                if (limit) {
                  onError(limit === "count" ? "К одному сообщению можно прикрепить не больше 5 изображений" : "Общий размер изображений в сообщении не должен превышать 50 МиБ");
                  throw new Error(`attachment_${limit}_limit`);
                }
                const reservationId = crypto.randomUUID();
                reservations.current.set(reservationId, file.size);
                fileReservations.current.set(file, reservationId);
                try {
                  const attachment = await onUpload(file);
                  return {
                    type: "url" as const,
                    value: attachment.url,
                    mimeType: attachment.mediaType,
                    metadata: { attachment_id: attachment.id, reservation_id: reservationId },
                  };
                } catch {
                  releaseReservations([reservationId]);
                  throw new Error("attachment_upload_failed");
                }
              },
              onUploadFailed: ({ file, message, reason }) => {
                const reservationId = fileReservations.current.get(file);
                if (reservationId) releaseReservations([reservationId]);
                if (message === "attachment_count_limit") onError("К одному сообщению можно прикрепить не больше 5 изображений");
                else if (message === "attachment_size_limit" || reason === "file-too-large") onError("Общий размер изображений в сообщении не должен превышать 50 МиБ");
                else if (reason === "invalid-type") onError("Поддерживаются только изображения JPEG, PNG и WebP");
                else onError("Изображение не загружено. Попробуйте ещё раз");
              },
            }}
          />
        </div>
      </BraiCopilotContext.Provider>
    </CopilotKit>
  );
}

function BraiDefaultToolRenderer() {
  const context = useRequiredContext();
  useDefaultRenderTool({
    render: ({ name, parameters, result, status }) => {
      if (name === "image_generation" || name === "image_view") {
        const artifact = parseToolResult(result);
        const attachmentId = typeof artifact?.attachment_id === "string" ? artifact.attachment_id : null;
        return (
          <div className="my-2 grid gap-2 rounded-lg border border-border bg-card p-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground"><ImageIcon className="size-4" aria-hidden="true" />{status === "complete" ? attachmentId ? "Изображение готово" : "Не удалось подготовить изображение" : "Создаю изображение…"}</div>
            {attachmentId ? <BraiChatImage attachmentId={attachmentId} label={typeof artifact?.name === "string" ? artifact.name : "Изображение Брая"} loadBlob={context.loadAttachment} /> : null}
          </div>
        );
      }
      if (name === "web_search") {
        const query = recordValue(parameters) && typeof parameters.query === "string" ? parameters.query : "";
        return (
          <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
            <Search className="size-4" aria-hidden="true" />
            <span>{status === "complete" ? "Поиск завершён" : "Ищу в публичных источниках…"}{query ? `: ${query}` : ""}</span>
          </div>
        );
      }
      return <div className="my-2 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">{status === "complete" ? "Операция завершена" : "Выполняю операцию…"}</div>;
    },
  }, [context.loadAttachment]);
  return null;
}

function BraiChatViewComponent(props: ComponentProps<typeof CopilotChat.View>) {
  const context = useRequiredContext();
  const { onError, onRetryChange, onRunFinished } = context;
  const { agent } = useAgent({ agentId: BRAI_AGENT_ID, updates: [UseAgentUpdate.OnRunStatusChanged] });
  const { copilotkit } = useCopilotKit();
  const running = Boolean(agent.isRunning || props.isRunning);
  const wasRunning = useRef(running);
  const preserveNextEmptyDraft = useRef(false);

  const retryLast = useCallback(async () => {
    try {
      await copilotkit.runAgent({ agent });
    } catch {
      onError("Повторный ответ не запущен. Попробуйте ещё раз", true);
    }
  }, [agent, copilotkit, onError]);

  useEffect(() => {
    if (wasRunning.current && !running) onRunFinished();
    wasRunning.current = running;
  }, [onRunFinished, running]);

  const lastMessage = props.messages?.at(-1);
  const canRetry = !running && (lastMessage?.role === "user" || lastMessage?.role === "assistant");

  useEffect(() => {
    onRetryChange(canRetry ? retryLast : null);
    return () => onRetryChange(null);
  }, [canRetry, onRetryChange, retryLast]);

  function submit(value: string) {
    if ((agent.isRunning || props.isRunning) && value.trim()) {
      const messageId = crypto.randomUUID();
      agent.addMessage({ id: messageId, role: "user", content: value });
      context.setDraft("");
      void context.onSteer(messageId, value).catch(() => context.onError("Сообщение не направлено в активный ответ. Попробуйте ещё раз"));
      return;
    }
    if ((agent.isRunning || props.isRunning) && props.attachments?.length) {
      preserveNextEmptyDraft.current = true;
      context.onError("Изображения можно отправить после завершения текущего ответа");
      return;
    }
    if (props.attachments?.some((attachment) => attachment.status === "uploading")) {
      preserveNextEmptyDraft.current = true;
      context.onError("Дождитесь загрузки изображений перед отправкой");
      return;
    }
    const reservationIds = (props.attachments ?? []).flatMap((attachment) => {
      const id = attachment.metadata?.reservation_id;
      return attachment.status === "ready" && typeof id === "string" ? [id] : [];
    });
    props.onSubmitMessage?.(value);
    context.releaseReservations(reservationIds);
  }

  function changeDraft(value: string) {
    if (!value && preserveNextEmptyDraft.current) {
      preserveNextEmptyDraft.current = false;
      return;
    }
    preserveNextEmptyDraft.current = false;
    context.setDraft(value);
  }

  function removeAttachment(id: string) {
    const attachment = props.attachments?.find((item) => item.id === id);
    const reservationId = attachment?.metadata?.reservation_id;
    if (typeof reservationId === "string") context.releaseReservations([reservationId]);
    const attachmentId = attachment?.metadata?.attachment_id;
    if (typeof attachmentId === "string") {
      void context.onDeleteAttachment(attachmentId).catch(() =>
        context.onError("Не удалось удалить загруженное изображение; оно будет очищено автоматически"));
    }
    props.onRemoveAttachment?.(id);
  }

  return (
    <CopilotChat.View
      {...props}
      input={{
        className: "pb-1",
        positioning: "static",
        bottomAnchored: true,
        showDisclaimer: false,
        textArea: BraiChatTextArea,
        sendButton: BraiChatSendButton,
        addMenuButton: BraiChatAddMenuButton,
        disclaimer: { className: "text-muted-foreground" },
      }}
      scrollView={BraiChatScrollView}
      welcomeScreen={false}
      inputValue={context.draft}
      onInputChange={changeDraft}
      onSubmitMessage={submit}
      onRemoveAttachment={removeAttachment}
    />
  );
}

const BraiChatView = Object.assign(BraiChatViewComponent, CopilotChat.View);

const BraiChatTextArea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(function BraiChatTextArea(
  { className, ...props },
  ref,
) {
  return (
    <Textarea
      {...props}
      ref={ref}
      bare
      id="brai-chat-message"
      name="message"
      aria-label="Сообщение Браю"
      data-testid="copilot-chat-textarea"
      placeholder={props.placeholder ?? "Напишите Браю…"}
      className={cx("w-full resize-none bg-transparent text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground", className)}
    />
  );
});

function BraiChatSendButton({ className, children, ...props }: ComponentProps<typeof CopilotChatInput.SendButton>) {
  return (
    <Button
      {...props}
      type="button"
      size="icon"
      className={cx("size-9 rounded-full", className)}
      data-testid="copilot-send-button"
      aria-label={children ? "Остановить ответ" : "Отправить сообщение"}
    >
      {children ?? <ArrowUp className="size-4" aria-hidden="true" />}
    </Button>
  );
}

function BraiChatAddMenuButton({
  className,
  onAddFile,
  toolsMenu,
  ...props
}: ComponentProps<typeof CopilotChatInput.AddMenuButton>) {
  if (toolsMenu?.length) {
    return <CopilotChatInput.AddMenuButton {...props} className={className} onAddFile={onAddFile} toolsMenu={toolsMenu} />;
  }
  return (
    <Button
      {...props}
      type="button"
      size="icon"
      variant="ghost"
      className={cx("size-9 rounded-full text-muted-foreground hover:text-accent-foreground", className)}
      data-testid="copilot-add-menu-button"
      aria-label="Добавить изображение"
      title="Добавить изображение"
      disabled={props.disabled || !onAddFile}
      onClick={onAddFile}
    >
      <Plus className="size-5" aria-hidden="true" />
    </Button>
  );
}

function BraiChatScrollToBottomButton({
  className,
  ...props
}: ComponentProps<typeof CopilotChat.View.ScrollToBottomButton>) {
  return (
    <Button
      {...props}
      type="button"
      size="icon"
      variant="outline"
      className={cx("pointer-events-auto size-10 rounded-full bg-card text-muted-foreground shadow-sm hover:text-accent-foreground", className)}
      data-testid="copilot-scroll-to-bottom"
      aria-label="Прокрутить к последнему сообщению"
    >
      <ChevronDown className="size-4" aria-hidden="true" />
    </Button>
  );
}

function BraiChatScrollView({
  className,
  ...props
}: ComponentProps<typeof CopilotChat.View.ScrollView>) {
  return (
    <CopilotChat.View.ScrollView
      {...props}
      className={cx(
        "text-foreground [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:size-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent",
        className,
      )}
      scrollToBottomButton={BraiChatScrollToBottomButton}
    />
  );
}

function AnchoredAssistantMessageComponent(props: ComponentProps<typeof CopilotChatAssistantMessage>) {
  const context = useRequiredContext();
  const { agent } = useAgent({ agentId: BRAI_AGENT_ID, updates: [UseAgentUpdate.OnRunStatusChanged] });
  const { copilotkit } = useCopilotKit();
  const lastMessage = props.messages?.at(-1);
  const canRetry = !props.isRunning && !agent.isRunning && lastMessage?.role === "assistant" && lastMessage.id === props.message.id;

  async function retry() {
    try {
      await copilotkit.runAgent({ agent });
    } catch {
      context.onError("Повторный ответ не запущен. Попробуйте ещё раз", true);
    }
  }

  return (
    <CopilotChatAssistantMessage
      {...props}
      id={`brai-message-${props.message.id}`}
      className={cx("text-foreground", props.className)}
      onRegenerate={canRetry ? () => void retry() : undefined}
    />
  );
}

const AnchoredAssistantMessage = Object.assign(AnchoredAssistantMessageComponent, CopilotChatAssistantMessage);

function BraiReasoningMessageComponent(props: ComponentProps<typeof CopilotChatReasoningMessage>) {
  return (
    <CopilotChatReasoningMessage
      {...props}
      className={cx("rounded-lg border border-border bg-card text-foreground", props.className)}
      header={{ className: "text-muted-foreground hover:text-foreground" }}
      contentView={{ className: "text-muted-foreground" }}
    />
  );
}

const BraiReasoningMessage = Object.assign(BraiReasoningMessageComponent, CopilotChatReasoningMessage);

function AnchoredUserMessageComponent(props: ComponentProps<typeof CopilotChatUserMessage>) {
  return <CopilotChatUserMessage {...props} id={`brai-message-${props.message.id}`} className={cx("text-foreground", props.className)} />;
}

const AnchoredUserMessage = Object.assign(AnchoredUserMessageComponent, CopilotChatUserMessage);

function useRequiredContext(): BraiCopilotContextValue {
  const value = useContext(BraiCopilotContext);
  if (!value) throw new Error("brai_copilot_context_missing");
  return value;
}

function parseToolResult(result: string | undefined): Record<string, unknown> | null {
  if (!result) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    return recordValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
