import { AudioLines, Command, Power, ShieldCheck, TriangleAlert, UserRound } from "lucide-react";
import { toggleBraiCmdFunctionAction } from "@/app/actions";
import { Badge } from "@/shared/ui/badge";
import { Card, CardDescription, CardFrame, CardHeader, CardTitle } from "@/shared/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { formatBytes, formatUtc } from "@/lib/format";
import type { BraiCmdAdminSummary } from "@/lib/braiCmdSummary";

export function BraiCmdAdminSection({ summary }: { summary: BraiCmdAdminSummary }) {
  const metrics = [
    {
      label: "Активные доступы",
      value: summary.totals.activeTokens.toLocaleString("ru-RU"),
      detail: `${summary.totals.revokedTokens.toLocaleString("ru-RU")} отозвано`,
      icon: ShieldCheck,
    },
    {
      label: "Запросы",
      value: summary.totals.requests.toLocaleString("ru-RU"),
      detail: `${summary.totals.successes.toLocaleString("ru-RU")} успешных`,
      icon: Command,
    },
    {
      label: "Пользователи",
      value: summary.totals.registeredTokens.toLocaleString("ru-RU"),
      detail: `${summary.totals.preliminaryTokens.toLocaleString("ru-RU")} предварительных · ${summary.totals.legacyTokens.toLocaleString("ru-RU")} legacy`,
      icon: UserRound,
    },
    {
      label: "Аудио",
      value: formatSeconds(summary.totals.audioDurationMs),
      detail: formatBytes(summary.totals.audioBytes),
      icon: AudioLines,
    },
    {
      label: "Символы",
      value: summary.totals.transcriptChars.toLocaleString("ru-RU"),
      detail: `${formatMilliseconds(summary.totals.totalMs)} суммарно`,
      icon: Command,
    },
    {
      label: "Ошибки",
      value: summary.totals.errors.toLocaleString("ru-RU"),
      detail: summary.totals.requests ? `${formatPercent(summary.totals.errors / summary.totals.requests)} запросов` : "0%",
      icon: TriangleAlert,
    },
  ];

  return (
    <>
      <Card>
        <CardHeader className="gap-2 p-4 md:p-5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <Command className="size-4 shrink-0" />
            <span>Brai Cmd</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="m-0 text-2xl font-semibold leading-none">Статистика</h1>
            <Badge variant={summary.settings.registrationEnabled ? "default" : "secondary"}>
              {summary.settings.registrationEnabled ? "Новые доступы включены" : "Новые доступы выключены"}
            </Badge>
          </div>
          <p className="m-0 text-sm leading-6 text-muted-foreground">
            Сводка по токенам доступа и usage-событиям из таблиц <code>brai_cmd_access_tokens</code> и{" "}
            <code>brai_cmd_usage_events</code>.
          </p>
        </CardHeader>
      </Card>

      <CardFrame className="min-w-0">
        <Card>
          <CardHeader className="gap-1.5 p-4">
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <Power className="size-4 shrink-0" />
              <span>Настройки</span>
            </div>
            <CardTitle className="text-base">Функции</CardTitle>
            <CardDescription>Выключенная функция сразу получает ответ сервера: Функция временно недоступна.</CardDescription>
          </CardHeader>
        </Card>
        <div className="grid gap-0 p-2 sm:grid-cols-2 xl:grid-cols-3">
          {Object.values(summary.settings.functions).map((item) => (
            <form action={toggleBraiCmdFunctionAction} className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2.5" key={item.key}>
              <input name="key" type="hidden" value={item.key} />
              <input name="enabled" type="hidden" value={item.enabled ? "false" : "true"} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{item.title}</div>
                <Badge className="mt-1" variant={item.enabled ? "default" : "secondary"}>
                  {item.enabled ? "Включена" : "Выключена"}
                </Badge>
              </div>
              <button
                aria-checked={item.enabled}
                aria-label={item.enabled ? `Выключить ${item.title}` : `Включить ${item.title}`}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                  item.enabled ? "border-primary bg-primary" : "border-border bg-muted"
                }`}
                role="switch"
                type="submit"
              >
                <span
                  className={`inline-block size-5 rounded-full bg-card shadow-sm transition-transform ${
                    item.enabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </form>
          ))}
        </div>
      </CardFrame>

      <section className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-6">
        {metrics.map((metric) => (
          <Card key={metric.label} className="min-w-0">
            <CardHeader className="gap-2 p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <metric.icon className="size-4 shrink-0" />
                <span>{metric.label}</span>
              </div>
              <div className="text-2xl font-semibold leading-none">{metric.value}</div>
              <CardDescription>{metric.detail}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      <CardFrame className="min-w-0">
        <Card>
          <CardHeader className="gap-1.5 p-4">
            <CardTitle className="text-base">Доступы</CardTitle>
            <CardDescription>{summary.tokens.length.toLocaleString("ru-RU")} токенов</CardDescription>
          </CardHeader>
        </Card>
        {summary.tokens.length ? (
          <Table variant="card">
            <TableHeader>
              <TableRow>
                {["Имя", "Тип", "Статус", "Запросы", "Аудио", "Символы", "Ошибки", "Последнее"].map((column) => (
                  <TableHead key={column}>{column}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="!whitespace-normal !align-top">
                    <div className="grid gap-1">
                      <div className="font-medium">{token.displayName}</div>
                      <div className="text-xs text-muted-foreground">
                        {[token.clientVersion, token.source, token.appPackage].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="!whitespace-normal !align-top">
                    <Badge variant={token.owner.type === "registered" ? "default" : "secondary"}>{ownerTypeLabel(token.owner.type)}</Badge>
                    <div className="mt-1 text-xs text-muted-foreground">{token.owner.label}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={token.status === "active" ? "default" : "secondary"}>{token.status}</Badge>
                  </TableCell>
                  <TableCell>{token.usage.requests.toLocaleString("ru-RU")}</TableCell>
                  <TableCell className="!whitespace-normal !align-top">
                    <div>{formatSeconds(token.usage.audioDurationMs)}</div>
                    <div className="text-xs text-muted-foreground">{formatBytes(token.usage.audioBytes)}</div>
                  </TableCell>
                  <TableCell>{token.usage.transcriptChars.toLocaleString("ru-RU")}</TableCell>
                  <TableCell>{token.usage.errors.toLocaleString("ru-RU")}</TableCell>
                  <TableCell className="!whitespace-normal !align-top">
                    <div>{token.lastUsedAt ? formatUtc(token.lastUsedAt) : "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {token.activatedAt ? `Активирован ${formatUtc(token.activatedAt)}` : "Ещё не активирован"}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Card className="p-4">
            <p className="m-0 text-sm text-muted-foreground">Brai Cmd ещё не выдал ни одного доступа.</p>
          </Card>
        )}
      </CardFrame>

      <CardFrame className="min-w-0">
        <Card>
          <CardHeader className="gap-1.5 p-4">
            <CardTitle className="text-base">Последние события</CardTitle>
            <CardDescription>Последние 50 usage-событий Brai Cmd.</CardDescription>
          </CardHeader>
        </Card>
        {summary.recentUsage.length ? (
          <Table variant="card">
            <TableHeader>
              <TableRow>
                {["Время", "Имя", "Результат", "Секунды", "Модель", "Символы", "Latency"].map((column) => (
                  <TableHead key={column}>{column}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.recentUsage.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>{formatUtc(event.createdAt)}</TableCell>
                  <TableCell className="!whitespace-normal !align-top">
                    <div>{event.displayName}</div>
                    <div className="text-xs text-muted-foreground">{ownerTypeLabel(event.owner.type)} · {event.owner.label}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={event.success ? "default" : "secondary"}>
                      {event.success ? "ok" : event.errorCode || "error"}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatSeconds(event.audioDurationMs)}</TableCell>
                  <TableCell className="!whitespace-normal !align-top">
                    <div>{[event.provider, event.model].filter(Boolean).join(" / ") || "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {event.fallbackUsed ? "Использован fallback" : "Без fallback"}
                    </div>
                  </TableCell>
                  <TableCell>{event.transcriptChars.toLocaleString("ru-RU")}</TableCell>
                  <TableCell className="!whitespace-normal !align-top">
                    <div>{formatMilliseconds(event.totalMs)}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatMilliseconds(event.transcriptionMs)} STT + {formatMilliseconds(event.postProcessingMs)} post
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Card className="p-4">
            <p className="m-0 text-sm text-muted-foreground">Usage-событий пока нет.</p>
          </Card>
        )}
      </CardFrame>
    </>
  );
}

function formatSeconds(milliseconds: number) {
  return `${(Math.round(milliseconds / 100) / 10).toLocaleString("ru-RU")} c`;
}

function formatMilliseconds(milliseconds: number) {
  return `${milliseconds.toLocaleString("ru-RU")} ms`;
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function ownerTypeLabel(type: "legacy" | "preliminary" | "registered") {
  if (type === "registered") return "Зарегистрирован";
  if (type === "preliminary") return "Предварительный";
  return "Legacy";
}
