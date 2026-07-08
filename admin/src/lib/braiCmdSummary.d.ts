export type BraiCmdUsage = {
  requests: number;
  successes: number;
  errors: number;
  audioBytes: number;
  audioDurationMs: number;
  transcriptChars: number;
  transcriptionMs: number;
  postProcessingMs: number;
  totalMs: number;
};

export type BraiCmdTokenSummary = {
  id: string;
  displayName: string;
  status: string;
  source: string;
  createdAt: string;
  activatedAt: string | null;
  lastUsedAt: string | null;
  clientVersion: string;
  appPackage: string;
  deviceBound: boolean;
  usage: BraiCmdUsage;
};

export type BraiCmdRecentUsage = {
  id: string;
  displayName: string;
  createdAt: string;
  success: boolean;
  errorCode: string | null;
  audioBytes: number;
  audioDurationMs: number;
  provider: string;
  model: string;
  fallbackUsed: boolean;
  transcriptionMs: number;
  postProcessingMs: number;
  totalMs: number;
  transcriptChars: number;
};

export type BraiCmdAdminSummary = {
  settings: {
    registrationEnabled: boolean;
  };
  totals: BraiCmdUsage & {
    activeTokens: number;
    revokedTokens: number;
  };
  tokens: BraiCmdTokenSummary[];
  recentUsage: BraiCmdRecentUsage[];
};

export function readBraiCmdAdminSummary(options?: {
  databaseUrl?: string;
}): Promise<BraiCmdAdminSummary>;
