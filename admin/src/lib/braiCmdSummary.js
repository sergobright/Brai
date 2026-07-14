import { openDatabase, openReadOnlyDatabase, resolveDatabaseUrl } from "./database.js";

export const BRAI_CMD_FUNCTIONS = Object.freeze([
  { key: "main_dictation", title: "Диктовка голос в текст" },
  { key: "idea_voice_inbox", title: "Идея голосом во входящие" },
  { key: "screenshot_inbox", title: "Скриншот во входящие" },
  { key: "screenshot_voice_inbox", title: "Скриншот и голос во входящие" },
  { key: "chat_context_inbox", title: "JSON чата и голос во входящие" },
  { key: "save_context_inbox", title: "Сохранить JSON и голос во входящие" },
]);

const BRAI_CMD_FUNCTION_KEYS = new Set(BRAI_CMD_FUNCTIONS.map((item) => item.key));

export async function readBraiCmdAdminSummary({
  databaseUrl = resolveDatabaseUrl(),
} = {}) {
  const db = openReadOnlyDatabase(databaseUrl);
  const client = await db.connect();
  let done = false;
  try {
    await client.query("START TRANSACTION READ ONLY");
    const settingsRows = await client.query(`
      SELECT key, value
      FROM brai_cmd_settings
      WHERE key = 'registration_enabled' OR key LIKE 'function.%.enabled'
    `);
    const tokenRows = await client.query(`
      SELECT t.*,
             p.status AS preliminary_status,
             p.user_id AS preliminary_user_id,
             p.display_name AS preliminary_display_name,
             au.email AS auth_user_email,
             au.name AS auth_user_name,
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
      LEFT JOIN preliminary_users p ON p.id = t.preliminary_users_id
      LEFT JOIN "user" au ON au.id = COALESCE(t.user_id, p.user_id)
      GROUP BY t.id, p.id, au.id
      ORDER BY t.created_at_utc DESC
    `);
    const recentUsageRows = await client.query(`
      SELECT u.*,
             t.display_name,
             t.preliminary_users_id,
             t.user_id,
             p.status AS preliminary_status,
             p.user_id AS preliminary_user_id,
             p.display_name AS preliminary_display_name,
             au.email AS auth_user_email,
             au.name AS auth_user_name
      FROM brai_cmd_usage_events u
      LEFT JOIN brai_cmd_access_tokens t ON t.id = u.access_token_id
      LEFT JOIN preliminary_users p ON p.id = t.preliminary_users_id
      LEFT JOIN "user" au ON au.id = COALESCE(t.user_id, p.user_id)
      ORDER BY u.created_at_utc DESC
      LIMIT 50
    `);

    const tokens = tokenRows.rows.map(formatTokenSummary);
    const totals = tokens.reduce((acc, token) => addBraiCmdUsage(acc, token.usage), emptyBraiCmdUsage());
    const preliminaryUsage = tokens
      .filter((token) => token.owner.type === "preliminary")
      .reduce((acc, token) => addBraiCmdUsage(acc, token.usage), emptyBraiCmdUsage());
    const registeredUsage = tokens
      .filter((token) => token.owner.type === "registered")
      .reduce((acc, token) => addBraiCmdUsage(acc, token.usage), emptyBraiCmdUsage());
    const legacyUsage = tokens
      .filter((token) => token.owner.type === "legacy")
      .reduce((acc, token) => addBraiCmdUsage(acc, token.usage), emptyBraiCmdUsage());

    await client.query("COMMIT");
    done = true;
    return {
      settings: {
        registrationEnabled: settingsValue(settingsRows.rows, "registration_enabled") !== "false",
        functions: formatBraiCmdFunctionSettings(settingsRows.rows),
      },
      totals: {
        ...totals,
        activeTokens: tokens.filter((token) => token.status === "active").length,
        revokedTokens: tokens.filter((token) => token.status === "revoked").length,
        preliminaryTokens: tokens.filter((token) => token.owner.type === "preliminary").length,
        registeredTokens: tokens.filter((token) => token.owner.type === "registered").length,
        legacyTokens: tokens.filter((token) => token.owner.type === "legacy").length,
        preliminaryUsage,
        registeredUsage,
        legacyUsage,
      },
      tokens,
      recentUsage: recentUsageRows.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name ?? "Unknown",
        owner: ownerSummary(row),
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

export async function setBraiCmdFunctionEnabled(key, enabled, { databaseUrl = resolveDatabaseUrl() } = {}) {
  if (!BRAI_CMD_FUNCTION_KEYS.has(key)) throw new Error("unknown_brai_cmd_function");
  const db = openDatabase(databaseUrl);
  const now = new Date().toISOString();
  try {
    await db.query(
      `
        INSERT INTO brai_cmd_settings (key, value, updated_at_utc)
        VALUES ($1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at_utc = EXCLUDED.updated_at_utc
      `,
      [`function.${key}.enabled`, enabled ? "true" : "false", now],
    );
    await recordBraiCmdSettingsLog(db, now, { [`function.${key}.enabled`]: enabled });
  } finally {
    await db.close();
  }
}

async function recordBraiCmdSettingsLog(db, now, jsonData) {
  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'logs'
  `);
  const existing = new Set(result.rows.map((row) => row.column_name));
  const valuesByColumn = {
    dt: now,
    observed_at_utc: now,
    severity_text: "INFO",
    service: "brai-admin",
    source: "brai-cmd",
    operation: "brai_cmd.admin_settings_update",
    status: "done",
    reason: null,
    message: "Brai Cmd admin settings updated",
    json_data: JSON.stringify(jsonData),
    expires_at_utc: new Date(Date.parse(now) + 180 * 24 * 60 * 60 * 1000).toISOString(),
    created_at_utc: now,
  };
  const columns = Object.keys(valuesByColumn).filter((column) => existing.has(column));
  if (!columns.includes("operation") || !columns.includes("status") || !columns.includes("message")) return;
  await db.query(
    `
      INSERT INTO logs (${columns.map((column) => `"${column}"`).join(", ")})
      VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
    `,
    columns.map((column) => valuesByColumn[column]),
  );
}

function settingsValue(rows, key) {
  return rows.find((row) => row.key === key)?.value;
}

function formatBraiCmdFunctionSettings(rows) {
  const saved = new Map();
  for (const row of rows) {
    const match = String(row.key ?? "").match(/^function\.([a-z0-9_]+)\.enabled$/);
    if (match && BRAI_CMD_FUNCTION_KEYS.has(match[1])) saved.set(match[1], row.value !== "false");
  }
  return Object.fromEntries(BRAI_CMD_FUNCTIONS.map((item) => [
    item.key,
    { ...item, enabled: saved.has(item.key) ? saved.get(item.key) : true },
  ]));
}

function formatTokenSummary(row) {
  return {
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
    owner: ownerSummary(row),
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
  };
}

function ownerSummary(row) {
  if (row.user_id) {
    return {
      type: "registered",
      userId: row.user_id,
      label: row.auth_user_email || row.auth_user_name || row.display_name || "Registered user",
      email: row.auth_user_email || null,
      name: row.auth_user_name || null,
    };
  }
  if (!row.preliminary_users_id) return { type: "legacy", label: "Legacy access token" };
  if (row.preliminary_status === "converted" && row.preliminary_user_id) {
    return {
      type: "registered",
      preliminaryUserId: row.preliminary_users_id,
      userId: row.preliminary_user_id,
      label: row.auth_user_email || row.auth_user_name || row.preliminary_display_name || "Registered user",
      email: row.auth_user_email || null,
      name: row.auth_user_name || null,
    };
  }
  return {
    type: "preliminary",
    preliminaryUserId: row.preliminary_users_id,
    label: row.preliminary_display_name || "Preliminary user",
  };
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
