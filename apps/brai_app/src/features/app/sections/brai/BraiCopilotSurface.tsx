"use client";

import type { ComponentProps } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatUserMessage,
  CopilotKit,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { attachmentReservationError } from "./braiChatModel";

const BRAI_AGENT_ID = "brai-codex";
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

type BraiCopilotContextValue = {
  onError: (message: string, retryable?: boolean) => void;
  onDeleteAttachment: (id: string) => Promise<void>;
  onRetryChange: (retry: (() => Promise<void>) | null) => void;
  onRunFinished: () => void;
  onRunStateChange: (running: boolean) => void;
  onSteer: (messageId: string, text: string) => Promise<void>;
  releaseReservations: (ids: string[]) => void;
};

const BraiCopilotContext = createContext<BraiCopilotContextValue | null>(null);

export function BraiCopilotSurface({
  headers,
  onError,
  onDeleteAttachment,
  onRetryChange,
  onRunFinished,
  onRunStateChange,
  onSteer,
  onUpload,
  runtimeUrl,
  threadId,
}: {
  headers?: Record<string, string>;
  onError: (message: string, retryable?: boolean) => void;
  onDeleteAttachment: (id: string) => Promise<void>;
  onRetryChange: (retry: (() => Promise<void>) | null) => void;
  onRunFinished: () => void;
  onRunStateChange: (running: boolean) => void;
  onSteer: (messageId: string, text: string) => Promise<void>;
  onUpload: (file: File) => Promise<{ id: string; mediaType: string; url: string }>;
  runtimeUrl: string;
  threadId: string;
}) {
  const reservations = useRef(new Map<string, number>());
  const fileReservations = useRef(new WeakMap<File, string>());

  const releaseReservations = useCallback((ids: string[]) => {
    for (const id of ids) reservations.current.delete(id);
  }, []);

  const context = useMemo(() => ({
    onDeleteAttachment, onError, onRetryChange, onRunFinished, onRunStateChange, onSteer, releaseReservations,
  }), [onDeleteAttachment, onError, onRetryChange, onRunFinished, onRunStateChange, onSteer, releaseReservations]);

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
        <CopilotChat
          agentId={BRAI_AGENT_ID}
          threadId={threadId}
          className="h-full min-h-0"
          chatView={BraiChatView}
          labels={{
            chatInputPlaceholder: "Напишите Браю…",
            welcomeMessageText: "Чем помочь? Среда изолирована и доступна только для чтения.",
            chatDisclaimerText: "Брай на базе Codex не имеет доступа к данным и проектам Brai.",
            assistantMessageToolbarRegenerateLabel: "Повторить ответ",
          }}
          messageView={{ assistantMessage: AnchoredAssistantMessage, userMessage: AnchoredUserMessage }}
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
      </BraiCopilotContext.Provider>
    </CopilotKit>
  );
}

function BraiChatViewComponent(props: ComponentProps<typeof CopilotChat.View>) {
  const context = useRequiredContext();
  const { onError, onRetryChange, onRunFinished, onRunStateChange } = context;
  const { agent } = useAgent({ agentId: BRAI_AGENT_ID, updates: [UseAgentUpdate.OnRunStatusChanged] });
  const { copilotkit } = useCopilotKit();
  const running = Boolean(agent.isRunning || props.isRunning);
  const wasRunning = useRef(running);

  const retryLast = useCallback(async () => {
    try {
      await copilotkit.runAgent({ agent });
    } catch {
      onError("Повторный ответ не запущен. Попробуйте ещё раз", true);
    }
  }, [agent, copilotkit, onError]);

  useEffect(() => {
    onRunStateChange(running);
    if (wasRunning.current && !running) onRunFinished();
    wasRunning.current = running;
  }, [onRunFinished, onRunStateChange, running]);

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
      props.onInputChange?.("");
      void context.onSteer(messageId, value).catch(() => context.onError("Сообщение не направлено в активный ответ. Попробуйте ещё раз"));
      return;
    }
    if ((agent.isRunning || props.isRunning) && props.attachments?.length) {
      context.onError("Изображения можно отправить после завершения текущего ответа");
      return;
    }
    if (props.attachments?.some((attachment) => attachment.status === "uploading")) {
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
        textArea: { id: "brai-chat-message", name: "message", "aria-label": "Сообщение Браю" },
        sendButton: { "aria-label": running ? "Остановить ответ" : "Отправить сообщение" },
        addMenuButton: { "aria-label": "Добавить изображение" },
      }}
      onSubmitMessage={submit}
      onRemoveAttachment={removeAttachment}
    />
  );
}

const BraiChatView = Object.assign(BraiChatViewComponent, CopilotChat.View);

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
      onRegenerate={canRetry ? () => void retry() : undefined}
    />
  );
}

const AnchoredAssistantMessage = Object.assign(AnchoredAssistantMessageComponent, CopilotChatAssistantMessage);

function AnchoredUserMessageComponent(props: ComponentProps<typeof CopilotChatUserMessage>) {
  return <CopilotChatUserMessage {...props} id={`brai-message-${props.message.id}`} />;
}

const AnchoredUserMessage = Object.assign(AnchoredUserMessageComponent, CopilotChatUserMessage);

function useRequiredContext(): BraiCopilotContextValue {
  const value = useContext(BraiCopilotContext);
  if (!value) throw new Error("brai_copilot_context_missing");
  return value;
}
