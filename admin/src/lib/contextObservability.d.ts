export type ContextRow = Record<string, unknown>;

export type ContextObservabilitySummary = {
  limit: number;
  relationTypes: ContextRow[];
  relations: ContextRow[];
  relationPagination: {
    page: number;
    pageSize: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  relationEvents: ContextRow[];
  decisions: ContextRow[];
  policies: ContextRow[];
  labels: ContextRow[];
  audits: ContextRow[];
  operations: ContextRow[];
  watermarks: ContextRow[];
  notifications: ContextRow[];
  agents: ContextRow[];
  services: ContextRow[];
  aiLogs: ContextRow[];
  diagnostics: ContextRow[];
};

export function readContextObservability(options?: {
  databaseUrl?: string;
  limit?: number;
  relationPage?: number;
}): Promise<ContextObservabilitySummary>;
