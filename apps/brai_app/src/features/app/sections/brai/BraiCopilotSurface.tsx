"use client";

import type { ComponentProps, CSSProperties } from "react";
import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, ImageIcon, Plus, Search } from "lucide-react";
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
import { cn } from "@/shared/ui/cn";
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
  // CopilotKit uses `card` for its default message and scroll surfaces. A
  // separate card color makes a visible rectangle inside the app workspace.
  "--card": "var(--brai-copilot-background)",
  "--card-foreground": "var(--brai-copilot-card-foreground)",
  "--cpk-default-font-family": "var(--font-app-sans)",
  "--cpk-default-mono-font-family": "var(--font-app-mono)",
  "--cpk-color-black": "var(--brai-copilot-foreground)",
  // The stock chat uses these as its scroll and input backgrounds. Keeping
  // them on `background` prevents a second, lighter rectangle below chat
  // content and the composer in the dark shell.
  "--cpk-color-gray-100": "var(--brai-copilot-background)",
  "--cpk-color-gray-200": "var(--brai-copilot-background)",
  "--cpk-color-gray-400": "var(--brai-copilot-muted-foreground)",
  "--cpk-color-gray-500": "var(--brai-copilot-muted-foreground)",
  "--cpk-color-gray-700": "var(--brai-copilot-border)",
  "--cpk-color-gray-800": "var(--brai-copilot-accent)",
  "--cpk-color-gray-900": "var(--brai-copilot-foreground)",
  "--cpk-color-white": "var(--brai-copilot-background)",
  "--cpk-color-zinc-100": "var(--brai-copilot-foreground)",
  "--cpk-color-zinc-200": "var(--brai-copilot-foreground)",
  "--cpk-color-zinc-300": "var(--brai-copilot-muted-foreground)",
  "--cpk-color-zinc-400": "var(--brai-copilot-muted-foreground)",
  "--cpk-color-zinc-700": "var(--brai-copilot-accent)",
  "--cpk-color-zinc-800": "var(--brai-copilot-border)",
  "--cpk-color-zinc-900": "var(--brai-copilot-foreground)",
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
  autoFocusComposer: boolean;
  threadId: string;
  onError: (message: string, retryable?: boolean) => void;
  onDeleteAttachment: (id: string) => Promise<void>;
  onComposerReady: () => void;
  onRetryChange: (retry: (() => Promise<void>) | null) => void;
  onRunFinished: () => void;
  onSteer: (messageId: string, text: string) => Promise<void>;
  releaseReservations: (ids: string[]) => void;
  draft: string;
  setDraft: (value: string) => void;
  loadAttachment: (id: string, download?: boolean) => Promise<Blob>;
};

const BraiCopilotContext = createContext<BraiCopilotContextValue | null>(null);

type BraiScrollSignal = {
  threadId: string;
  messageCount: number;
  lastMessageRole: string | null;
  revision: string;
};

const BraiScrollSignalContext = createContext<BraiScrollSignal>({
  threadId: "",
  messageCount: 0,
  lastMessageRole: null,
  revision: "",
});

export const BraiCopilotSurface = memo(function BraiCopilotSurface({
  autoFocusComposer = false,
  headers,
  draftStorageKey,
  loadAttachment,
  onError,
  onDeleteAttachment,
  onComposerReady,
  onRetryChange,
  onRunFinished,
  onSteer,
  onUpload,
  runtimeBearerToken,
  runtimeUrl,
  theme,
  threadId,
}: {
  autoFocusComposer?: boolean;
  headers?: Record<string, string>;
  draftStorageKey: string;
  loadAttachment: (id: string, download?: boolean) => Promise<Blob>;
  onError: (message: string, retryable?: boolean) => void;
  onDeleteAttachment: (id: string) => Promise<void>;
  onComposerReady: () => void;
  onRetryChange: (retry: (() => Promise<void>) | null) => void;
  onRunFinished: () => void;
  onSteer: (messageId: string, text: string) => Promise<void>;
  onUpload: (file: File) => Promise<{ id: string; mediaType: string; url: string }>;
  runtimeBearerToken?: string | null;
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
    autoFocusComposer, draft, loadAttachment, onComposerReady, onDeleteAttachment, onError, onRetryChange, onRunFinished, onSteer, releaseReservations, setDraft, threadId,
  }), [autoFocusComposer, draft, loadAttachment, onComposerReady, onDeleteAttachment, onError, onRetryChange, onRunFinished, onSteer, releaseReservations, setDraft, threadId]);
  // CopilotKit treats a changed headers object as a changed runtime
  // configuration. The VisualViewport emits frequent updates while Android's
  // keyboard is open, so an unstable object here repeatedly reconnects the
  // chat and makes its auto-scroll visibly flicker.
  const runtimeHeaders = useMemo(() => ({
    ...headers,
    ...(runtimeBearerToken ? { Authorization: `Bearer ${runtimeBearerToken}` } : {}),
  }), [headers, runtimeBearerToken]);

  return (
    <CopilotKit
      runtimeUrl={runtimeUrl}
      agent={BRAI_AGENT_ID}
      threadId={threadId}
      credentials="include"
      headers={runtimeHeaders}
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
            className="h-full min-h-0 !bg-background text-foreground [&_.copilotKitChat]:!bg-background [&_[data-testid=copilot-scroll-content]]:!bg-background [&_[data-testid=copilot-chat-textarea]]:!text-foreground [&_[data-testid=copilot-chat-textarea]]:placeholder:!text-muted-foreground [&_[data-testid=copilot-slash-menu]]:!border-border [&_[data-testid=copilot-slash-menu]]:!bg-popover [&_[data-testid=copilot-slash-menu]]:!text-popover-foreground [&_[data-testid=copilot-slash-menu]_[role=option]:hover]:!bg-accent [&_[data-testid=copilot-slash-menu]_[role=option][data-active=true]]:!bg-accent"
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
});

function BraiDefaultToolRenderer() {
  const context = useRequiredContext();
  useDefaultRenderTool({
    render: ({ name, parameters, result, status }) => {
      if (name === "image_generation" || name === "image_view") {
        const artifact = parseToolResult(result);
        const attachmentId = typeof artifact?.attachment_id === "string" ? artifact.attachment_id : null;
        return (
          <div className="my-1.5 grid gap-1.5 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground"><ImageIcon className="size-4" aria-hidden="true" />{status === "complete" ? attachmentId ? "Изображение готово" : "Не удалось подготовить изображение" : "Создаю изображение…"}</div>
            {attachmentId ? <BraiChatImage attachmentId={attachmentId} label={typeof artifact?.name === "string" ? artifact.name : "Изображение Брая"} loadBlob={context.loadAttachment} /> : null}
          </div>
        );
      }
      if (name === "web_search") {
        const query = recordValue(parameters) && typeof parameters.query === "string" ? parameters.query : "";
        return (
          <div className="my-1.5 flex items-center gap-2 text-sm text-muted-foreground">
            <Search className="size-4" aria-hidden="true" />
            <span>{status === "complete" ? "Поиск завершён" : "Ищу в публичных источниках…"}{query ? `: ${query}` : ""}</span>
          </div>
        );
      }
      return <div className="my-1.5 text-sm text-muted-foreground">{status === "complete" ? "Операция завершена" : "Выполняю операцию…"}</div>;
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
  const steering = useRef(false);

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
  const scrollSignal = useMemo<BraiScrollSignal>(() => ({
    threadId: context.threadId,
    messageCount: props.messages?.length ?? 0,
    lastMessageRole: lastMessage?.role ?? null,
    revision: messageRevision(lastMessage),
  }), [context.threadId, lastMessage, props.messages?.length]);

  useEffect(() => {
    onRetryChange(canRetry ? retryLast : null);
    return () => onRetryChange(null);
  }, [canRetry, onRetryChange, retryLast]);

  function submit(value: string) {
    if ((agent.isRunning || props.isRunning) && value.trim()) {
      const messageId = crypto.randomUUID();
      if (steering.current) return;
      steering.current = true;
      // The runtime publishes the accepted steer back into this same stream.
      // Adding it optimistically here turns a late 409 into the next regular
      // request in CopilotKit, which is not a steer at all.
      void context.onSteer(messageId, value).then(() => {
        context.setDraft("");
      }).catch(() => {
        context.onError("Сообщение не направлено в активный ответ. Попробуйте ещё раз");
      }).finally(() => {
        steering.current = false;
      });
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
    <BraiScrollSignalContext.Provider value={scrollSignal}>
      <CopilotChat.View
        {...props}
        autoScroll="none"
        input={BraiCompactChatInput}
        scrollView={BraiChatScrollView}
        welcomeScreen={false}
        inputValue={context.draft}
        onInputChange={changeDraft}
        onSubmitMessage={submit}
        onRemoveAttachment={removeAttachment}
      />
    </BraiScrollSignalContext.Provider>
  );
}

const BraiChatView = Object.assign(BraiChatViewComponent, CopilotChat.View);

function BraiCompactChatInputComponent(props: ComponentProps<typeof CopilotChatInput>) {
  return (
    <CopilotChatInput
      {...props}
      positioning="static"
      bottomAnchored
      showDisclaimer={false}
      className="!min-h-0 !bg-transparent !p-0"
      textArea={BraiChatTextArea}
      sendButton={BraiChatSendButton}
      addMenuButton={BraiChatAddMenuButton}
    >
      {({ addMenuButton, sendButton, textArea }) => (
        <div
          data-copilotkit
          className="pointer-events-none relative z-20 bg-background px-3 pb-1 pt-0.5"
        >
          <div
            data-testid="copilot-chat-input"
            className="pointer-events-auto mx-auto grid min-h-0 w-full max-w-3xl grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1 rounded-xl border border-border bg-background px-1.5 py-1"
          >
            {addMenuButton}
            <div className="flex min-w-0 items-end">{textArea}</div>
            {sendButton}
          </div>
        </div>
      )}
    </CopilotChatInput>
  );
}

const BraiCompactChatInput = Object.assign(BraiCompactChatInputComponent, CopilotChatInput);

const BraiChatTextArea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(function BraiChatTextArea(
  { className, onKeyDown, ...props },
  ref,
) {
  const context = useRequiredContext();
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(ref, () => localRef.current as HTMLTextAreaElement, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (context.autoFocusComposer) localRef.current?.focus({ preventScroll: true });
      context.onComposerReady();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [context.autoFocusComposer, context.onComposerReady]);

  return (
    <Textarea
      {...props}
      ref={localRef}
      bare
      rows={1}
      id="brai-chat-message"
      name="message"
      aria-label="Сообщение Браю"
      data-testid="copilot-chat-textarea"
      placeholder={props.placeholder ?? "Напишите Браю…"}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          // Mobile keyboards must keep the textarea's native newline behavior.
          event.stopPropagation();
          return;
        }
        onKeyDown?.(event);
      }}
      className={cn("field-sizing-content box-border min-h-6 max-h-[50dvh] w-full resize-none overflow-y-auto bg-transparent !py-1 !pr-1 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground", className)}
    />
  );
});

function BraiChatSendButton({ className, children, ...props }: ComponentProps<typeof CopilotChatInput.SendButton>) {
  return (
    <Button
      {...props}
      type="button"
      size="icon"
      className={cx("size-8 rounded-full", className)}
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
      className={cx("size-8 rounded-full text-muted-foreground hover:text-accent-foreground", className)}
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
  autoScroll: _autoScroll,
  feather: _feather,
  inputContainerHeight = 0,
  isResizing: _isResizing,
  onScroll,
  scrollToBottomButton: _scrollToBottomButton,
  children,
  ...props
}: ComponentProps<typeof CopilotChat.View.ScrollView>) {
  void _autoScroll;
  void _feather;
  void _isResizing;
  void _scrollToBottomButton;
  const signal = useContext(BraiScrollSignalContext);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const previousSignal = useRef<BraiScrollSignal | null>(null);
  const previousScrollHeight = useRef(0);
  const pinnedToBottom = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const updatePinnedState = useCallback((element: HTMLDivElement) => {
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const pinned = distanceFromBottom <= 24;
    pinnedToBottom.current = pinned;
    setShowScrollButton(!pinned);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinnedToBottom.current = true;
    setShowScrollButton(false);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const previous = previousSignal.current;
    const initialReplay = previous === null || previous.threadId !== signal.threadId;
    const submittedUserMessage = Boolean(
      previous
      && signal.messageCount > previous.messageCount
      && signal.lastMessageRole === "user"
    );
    const contentGrew = element.scrollHeight > previousScrollHeight.current;

    if (initialReplay || submittedUserMessage || (pinnedToBottom.current && contentGrew)) {
      // Deliberately avoid smooth scrolling. CopilotKit's StickToBottom starts a
      // new animation for every controlled draft render and streaming token.
      // A direct assignment keeps mandatory chat autoscroll without per-token
      // animation queues or visible intermediate positions.
      element.scrollTop = element.scrollHeight;
      pinnedToBottom.current = true;
      setShowScrollButton(false);
    }

    previousSignal.current = signal;
    previousScrollHeight.current = element.scrollHeight;
  }, [inputContainerHeight, signal]);

  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === "undefined") return;
    let previousClientHeight = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextClientHeight = element.clientHeight;
      const nextScrollHeight = element.scrollHeight;
      if (
        pinnedToBottom.current
        && (nextClientHeight !== previousClientHeight || nextScrollHeight > previousScrollHeight.current)
      ) {
        element.scrollTop = element.scrollHeight;
      }
      previousClientHeight = nextClientHeight;
      previousScrollHeight.current = nextScrollHeight;
      updatePinnedState(element);
    });
    observer.observe(element);
    observer.observe(content);
    return () => observer.disconnect();
  }, [updatePinnedState]);

  return (
    <div
      {...props}
      ref={scrollRef}
      data-testid="brai-chat-scroll"
      className={cx(
        "relative flex h-full max-h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto !bg-background text-foreground [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:size-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent",
        className,
      )}
      onScroll={(event) => {
        updatePinnedState(event.currentTarget);
        onScroll?.(event);
      }}
    >
      <div ref={contentRef} className="px-4 @3xl:px-0 [div[data-popup-chat]_&]:px-6 [div[data-sidebar-chat]_&]:px-8">
        {children}
      </div>
      {showScrollButton ? (
        <div
          className="pointer-events-none sticky inset-x-0 z-30 flex h-0 justify-center"
          style={{ bottom: `${inputContainerHeight + 12}px` }}
        >
          <BraiChatScrollToBottomButton onClick={scrollToBottom} />
        </div>
      ) : null}
    </div>
  );
}

function messageRevision(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const content = record.content;
  const serializedContent = typeof content === "string" ? content : JSON.stringify(content ?? null);
  return [
    typeof record.id === "string" ? record.id : "",
    typeof record.role === "string" ? record.role : "",
    serializedContent.length,
    serializedContent.slice(-64),
    typeof record.status === "string" ? record.status : "",
  ].join(":");
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
      toolbar={{ className: "mt-0.5 flex !h-5 items-center gap-0.5" }}
      copyButton={{ className: "!size-5 !p-1 text-muted-foreground/30 hover:text-muted-foreground [&_svg]:!size-3" }}
      regenerateButton={{ className: "!size-5 !p-1 text-muted-foreground/30 hover:text-muted-foreground [&_svg]:!size-3" }}
      markdownRenderer={({ content, className, ...rendererProps }) => (
        <CopilotChatAssistantMessage.MarkdownRenderer
          {...rendererProps}
          className={cn(className, "!space-y-1.5 [&_p]:!my-0")}
          content={normalizeLatexDisplayMath(content)}
        />
      )}
      onRegenerate={canRetry ? () => void retry() : undefined}
    />
  );
}

const AnchoredAssistantMessage = Object.assign(AnchoredAssistantMessageComponent, CopilotChatAssistantMessage);

function BraiReasoningMessageComponent(props: ComponentProps<typeof CopilotChatReasoningMessage>) {
  return (
    <CopilotChatReasoningMessage
      {...props}
      className={cx("my-1 rounded-md border border-border/70 bg-transparent text-foreground", props.className)}
      header={BraiReasoningHeader}
      contentView={{ className: "px-2 pb-2 text-sm text-muted-foreground" }}
    />
  );
}

const BraiReasoningMessage = Object.assign(BraiReasoningMessageComponent, CopilotChatReasoningMessage);

/** Returns the public, localized status for a reasoning summary without exposing its raw chain of thought. */
export function braiReasoningLabel(isStreaming: boolean | undefined) {
  return isStreaming ? "Размышляю…" : "Размышлял несколько секунд";
}

function BraiReasoningHeader({
  children,
  className,
  hasContent,
  isOpen,
  isStreaming,
  label: _label,
  ...props
}: ComponentProps<typeof CopilotChatReasoningMessage.Header>) {
  return (
    <button
      {...props}
      type="button"
      aria-expanded={hasContent ? isOpen : undefined}
      className={cx(
        "inline-flex min-h-8 items-center gap-1 px-2 text-sm text-muted-foreground transition-colors",
        hasContent ? "cursor-pointer hover:text-foreground" : "cursor-default",
        className,
      )}
    >
      <span className="font-medium">{braiReasoningLabel(isStreaming)}</span>
      {isStreaming && !hasContent ? <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" aria-hidden="true" /> : null}
      {children}
      {hasContent ? <ChevronRight className={cx("size-3.5 shrink-0 transition-transform duration-200", isOpen && "rotate-90")} aria-hidden="true" /> : null}
    </button>
  );
}

function AnchoredUserMessageComponent(props: ComponentProps<typeof CopilotChatUserMessage>) {
  return <CopilotChatUserMessage {...props} id={`brai-message-${props.message.id}`} className={cx("!pt-3 text-foreground", props.className)} />;
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

/** Converts display delimiters emitted by Codex into Streamdown's KaTeX form. */
export function normalizeLatexDisplayMath(content: string): string {
  const normalized = content.replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => `$$\n${formula.trim()}\n$$`);
  return normalized.replace(/(^|\n)\[\s*((?=[^\n]*\\)[^\n]+?)\s*\](?=\n|$)/g, (_match, prefix: string, formula: string) => `${prefix}$$\n${formula.trim()}\n$$`);
}
