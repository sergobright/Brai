import type { RelationSyncIssue } from "@/shared/types/relations";

export function RelationSyncAlert({ issue }: { issue: RelationSyncIssue }) {
  return (
    <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm" role="status">
      <strong className="font-medium">Не все изменения состава синхронизированы.</strong>
      <p className="m-0 mt-1 text-muted-foreground">{issueMessage(issue)}</p>
    </div>
  );
}

function issueMessage(issue: RelationSyncIssue): string {
  if (issue.reason.startsWith("dependency_rejected:")) return "Связанное действие не было принято сервером; состав цели возвращён к сохранённому состоянию.";
  if (issue.reason === "stale_revision" || issue.reason === "relation_membership_changed") return "Состав цели изменился на другом устройстве; показано актуальное состояние.";
  if (issue.reason === "endpoint_not_ready") return "Связанный пункт ещё обрабатывается. Система повторит синхронизацию автоматически.";
  return "Изменение не применилось. Показано состояние, подтверждённое сервером.";
}
