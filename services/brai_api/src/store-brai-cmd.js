import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const braiCmdStoreMethods = {
  braiCmdSettings() {
    const row = this.db.prepare("SELECT value FROM brai_cmd_settings WHERE key = 'registration_enabled'").get();
    return { registrationEnabled: row?.value !== 'false' };
  },

  setBraiCmdRegistrationEnabled(registrationEnabled) {
    this.db.prepare(`
      INSERT INTO brai_cmd_settings (key, value, updated_at_utc)
      VALUES ('registration_enabled', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at_utc = excluded.updated_at_utc
    `).run(registrationEnabled ? 'true' : 'false', new Date().toISOString());
    safeRecordLog(this, {
      source: 'brai-cmd',
      operation: 'brai_cmd.admin_settings_update',
      status: 'done',
      message: 'Brai Cmd admin settings updated',
      jsonData: { registration_enabled: Boolean(registrationEnabled) }
    });
    return this.braiCmdSettings();
  },

  issueBraiCmdAccess(input) {
    const token = `aw_${randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      displayName: normalizeDisplayName(input.displayName),
      tokenHash: hashSecret(token),
      deviceIdHash: input.deviceId ? hashSecret(input.deviceId.trim()) : null,
      status: 'active',
      source: input.source === 'admin' ? 'admin' : 'self_service',
      createdAt: now,
      activatedAt: input.deviceId ? now : null,
      lastUsedAt: null,
      clientVersion: cleanMetadata(input.clientVersion),
      appPackage: cleanMetadata(input.appPackage)
    };
    this.db.prepare(`
      INSERT INTO brai_cmd_access_tokens (
        id, display_name, token_hash, device_id_hash, status, source,
        created_at_utc, activated_at_utc, last_used_at_utc, client_version, app_package
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.displayName,
      record.tokenHash,
      record.deviceIdHash,
      record.status,
      record.source,
      record.createdAt,
      record.activatedAt,
      record.lastUsedAt,
      record.clientVersion,
      record.appPackage
    );
    safeRecordLog(this, {
      dt: record.createdAt,
      source: 'brai-cmd',
      operation: 'brai_cmd.access_request',
      status: 'done',
      message: 'Brai Cmd access token issued',
      jsonData: {
        access_token_id: record.id,
        source: record.source,
        device_bound: Boolean(record.deviceIdHash),
        client_version_present: Boolean(record.clientVersion),
        app_package_present: Boolean(record.appPackage)
      }
    });
    return { token, record };
  },

  authenticateBraiCmdAccess(token, deviceId, clientVersion = '') {
    const tokenHash = hashSecret(token.trim());
    const deviceIdHash = hashSecret(deviceId.trim());
    const rows = this.db.prepare(`
      SELECT * FROM brai_cmd_access_tokens
      WHERE status = 'active'
      ORDER BY created_at_utc
    `).all();
    const row = rows.find((candidate) => safeEqualHex(candidate.token_hash, tokenHash));
    if (!row) return null;
    if (row.device_id_hash && !safeEqualHex(row.device_id_hash, deviceIdHash)) return null;

    const now = new Date().toISOString();
    const cleanVersion = cleanMetadata(clientVersion);
    this.db.prepare(`
      UPDATE brai_cmd_access_tokens
      SET device_id_hash = COALESCE(device_id_hash, ?),
          activated_at_utc = COALESCE(activated_at_utc, ?),
          last_used_at_utc = ?,
          client_version = CASE WHEN ? <> '' THEN ? ELSE client_version END
      WHERE id = ?
    `).run(deviceIdHash, now, now, cleanVersion, cleanVersion, row.id);
    return formatBraiCmdToken({
      ...row,
      device_id_hash: row.device_id_hash ?? deviceIdHash,
      activated_at_utc: row.activated_at_utc ?? now,
      last_used_at_utc: now,
      client_version: cleanVersion || row.client_version
    });
  },

  revokeBraiCmdToken(id) {
    const row = this.db.prepare('SELECT * FROM brai_cmd_access_tokens WHERE id = ?').get(id);
    if (!row) return null;
    this.db.prepare("UPDATE brai_cmd_access_tokens SET status = 'revoked' WHERE id = ?").run(id);
    safeRecordLog(this, {
      source: 'brai-cmd',
      operation: 'brai_cmd.token_revoke',
      status: 'done',
      message: 'Brai Cmd token revoked',
      jsonData: {
        access_token_id: id,
        previous_status: row.status,
        device_bound: Boolean(row.device_id_hash)
      }
    });
    return formatBraiCmdToken({ ...row, status: 'revoked' });
  },

  recordBraiCmdUsage(input) {
    const row = {
      id: randomUUID(),
      accessTokenId: input.accessTokenId,
      createdAt: new Date().toISOString(),
      success: input.success ? 1 : 0,
      errorCode: cleanMetadata(input.errorCode),
      audioBytes: safeNumber(input.audioBytes),
      audioDurationMs: safeNumber(input.audioDurationMs),
      provider: cleanMetadata(input.provider),
      model: cleanMetadata(input.model),
      fallbackUsed: input.fallbackUsed ? 1 : 0,
      transcriptionMs: safeNumber(input.transcriptionMs),
      postProcessingMs: safeNumber(input.postProcessingMs),
      totalMs: safeNumber(input.totalMs),
      transcriptChars: safeNumber(input.transcriptChars),
      clientVersion: cleanMetadata(input.clientVersion)
    };
    this.db.prepare(`
      INSERT INTO brai_cmd_usage_events (
        id, access_token_id, created_at_utc, success, error_code,
        audio_bytes, audio_duration_ms, provider, model, fallback_used,
        transcription_ms, post_processing_ms, total_ms, transcript_chars, client_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.accessTokenId,
      row.createdAt,
      row.success,
      row.errorCode,
      row.audioBytes,
      row.audioDurationMs,
      row.provider,
      row.model,
      row.fallbackUsed,
      row.transcriptionMs,
      row.postProcessingMs,
      row.totalMs,
      row.transcriptChars,
      row.clientVersion
    );
    this.recordLog?.({
      dt: row.createdAt,
      source: 'brai-cmd',
      operation: 'brai_cmd.dictate',
      status: row.success ? 'done' : 'failed',
      severityText: row.success ? 'INFO' : 'ERROR',
      message: row.success ? 'Brai Cmd request completed' : 'Brai Cmd request failed',
      jsonData: {
        access_token_id: row.accessTokenId,
        request_id: cleanMetadata(input.requestId) || null,
        route: cleanMetadata(input.route) || null,
        error_code: row.errorCode || null,
        audio_bytes: row.audioBytes,
        audio_duration_ms: row.audioDurationMs,
        provider: row.provider,
        model: row.model,
        fallback_used: Boolean(row.fallbackUsed),
        transcription_ms: row.transcriptionMs,
        post_processing_ms: row.postProcessingMs,
        total_ms: row.totalMs,
        transcript_chars: row.transcriptChars,
        client_version: row.clientVersion,
        post_processing_requested: Boolean(input.postProcessingRequested),
        context_requested: Boolean(input.contextRequested)
      }
    });
    return row;
  },

  braiCmdAdminSummary() {
    const tokens = this.db.prepare(`
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
    `).all().map((row) => ({
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
        requests: row.requests,
        successes: row.successes ?? 0,
        errors: row.errors ?? 0,
        audioBytes: row.audio_bytes,
        audioDurationMs: row.audio_duration_ms,
        transcriptChars: row.transcript_chars,
        transcriptionMs: row.transcription_ms,
        postProcessingMs: row.post_processing_ms,
        totalMs: row.total_ms
      }
    }));
    const totals = tokens.reduce((acc, token) => addUsage(acc, token.usage), emptyUsage());
    return {
      settings: this.braiCmdSettings(),
      totals: {
        ...totals,
        activeTokens: tokens.filter((token) => token.status === 'active').length,
        revokedTokens: tokens.filter((token) => token.status === 'revoked').length
      },
      tokens,
      recentUsage: this.db.prepare(`
        SELECT u.*, t.display_name
        FROM brai_cmd_usage_events u
        LEFT JOIN brai_cmd_access_tokens t ON t.id = u.access_token_id
        ORDER BY u.created_at_utc DESC
        LIMIT 50
      `).all().map((row) => ({
        id: row.id,
        displayName: row.display_name ?? 'Unknown',
        createdAt: row.created_at_utc,
        success: Boolean(row.success),
        errorCode: row.error_code || null,
        audioBytes: row.audio_bytes,
        audioDurationMs: row.audio_duration_ms,
        provider: row.provider,
        model: row.model,
        fallbackUsed: Boolean(row.fallback_used),
        transcriptionMs: row.transcription_ms,
        postProcessingMs: row.post_processing_ms,
        totalMs: row.total_ms,
        transcriptChars: row.transcript_chars
      }))
    };
  }
};

function formatBraiCmdToken(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    tokenHash: row.token_hash,
    deviceIdHash: row.device_id_hash,
    status: row.status,
    source: row.source,
    createdAt: row.created_at_utc,
    activatedAt: row.activated_at_utc,
    lastUsedAt: row.last_used_at_utc,
    clientVersion: row.client_version,
    appPackage: row.app_package
  };
}

function hashSecret(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(left, right) {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeDisplayName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) throw new Error('display_name_required');
  return name;
}

function cleanMetadata(value) {
  return String(value ?? '').trim().slice(0, 120);
}

function safeNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function safeRecordLog(store, input) {
  try {
    store.recordLog?.(input);
  } catch {
    // Brai Cmd token lifecycle must not depend on optional operation logging.
  }
}

function emptyUsage() {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    audioBytes: 0,
    audioDurationMs: 0,
    transcriptChars: 0,
    transcriptionMs: 0,
    postProcessingMs: 0,
    totalMs: 0
  };
}

function addUsage(left, right) {
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
