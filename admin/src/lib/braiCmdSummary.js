import { openReadOnlyDatabase, resolveDatabaseUrl } from "./database.js";

export async function readBraiCmdAdminSummary({
  databaseUrl = resolveDatabaseUrl(),
} = {}) {
  const db = openReadOnlyDatabase(databaseUrl);
  const client = await db.connect();
  let done = false;
  try {
    await client.query("START TRANSACTION READ ONLY");
    const settingsRow = await client.query(`
      SELECT value
      FROM brai_cmd_settings
      WHERE key = 'registration_enabled'
      LIMIT 1
    `);
    const tokenRows = await client.query(`
      SELECT t.*,
             COUNT(u.id) AS requests,
             SUM(CASE WHEN u.success = 1 THEN 1 ELSE 0 END) AS successes,
             SUM(CASE WHEN u.success = 0 THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(u.audio_bytes), 0) AS audio_bytes,
             COALESCE(SUM(u.audio_duration_ms), 0) AS audio_duration_ms,
             COALESCE(SUM(u.transcript_chars), 0) AS transcript_chars,
             COALESCE(SUM(u.transcription_ms), 0) AS transcription_ms,
             COALESCE(SUM(u.post_processing_ms), 0) AS post_processing_ms,
             COALESCE(SUM(u.total_ms), 0) AS total_ms
      FROM brai_cmd_access_tokens t
      LEFT JOIN brai_cmd_usage_events u ON u.access_token_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at_utc DESC
    `);
    const recentUsageRows = await client.query(`
      SELECT u.*, t.display_name
      FROM brai_cmd_usage_events u
      LEFT JOIN brai_cmd_access_tokens t ON t.id = u.access_token_id
      ORDER BY u.created_at_utc DESC
      LIMIT 50
    `);

    const tokens = tokenRows.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      source: row.source,
      createdAt: row.created_at_utc,
      activatedAt: row.activated_at_utc,
      lastUsedAt: row.last_used_at_utc,
      clientVersion: row.client_version,
      appPackage: row.app_package,
      deviceBound: Boolean(row.device_id_hash),
      usage: {
        requests: toNumber(row.requests),
        successes: toNumber(row.successes),
        errors: toNumber(row.errors),
        audioBytes: toNumber(row.audio_bytes),
        audioDurationMs: toNumber(row.audio_duration_ms),
        transcriptChars: toNumber(row.transcript_chars),
        transcriptionMs: toNumber(row.transcription_ms),
        postProcessingMs: toNumber(row.post_processing_ms),
        totalMs: toNumber(row.total_ms),
      },
    }));
    const totals = tokens.reduce((acc, token) => addBraiCmdUsage(acc, token.usage), emptyBraiCmdUsage());

    await client.query("COMMIT");
    done = true;
    return {
      settings: {
        registrationEnabled: settingsRow.rows[0]?.value !== "false",
      },
      totals: {
        ...totals,
        activeTokens: tokens.filter((token) => token.status === "active").length,
        revokedTokens: tokens.filter((token) => token.status === "revoked").length,
      },
      tokens,
      recentUsage: recentUsageRows.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name ?? "Unknown",
        createdAt: row.created_at_utc,
        success: Boolean(row.success),
        errorCode: row.error_code || null,
        audioBytes: toNumber(row.audio_bytes),
        audioDurationMs: toNumber(row.audio_duration_ms),
        provider: row.provider,
        model: row.model,
        fallbackUsed: Boolean(row.fallback_used),
        transcriptionMs: toNumber(row.transcription_ms),
        postProcessingMs: toNumber(row.post_processing_ms),
        totalMs: toNumber(row.total_ms),
        transcriptChars: toNumber(row.transcript_chars),
      })),
    };
  } finally {
    if (!done) await client.query("ROLLBACK").catch(() => {});
    client.release();
    await db.close();
  }
}

function emptyBraiCmdUsage() {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    audioBytes: 0,
    audioDurationMs: 0,
    transcriptChars: 0,
    transcriptionMs: 0,
    postProcessingMs: 0,
    totalMs: 0,
  };
}

function addBraiCmdUsage(left, right) {
  left.requests += right.requests;
  left.successes += right.successes;
  left.errors += right.errors;
  left.audioBytes += right.audioBytes;
  left.audioDurationMs += right.audioDurationMs;
  left.transcriptChars += right.transcriptChars;
  left.transcriptionMs += right.transcriptionMs;
  left.postProcessingMs += right.postProcessingMs;
  left.totalMs += right.totalMs;
  return left;
}

function toNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
