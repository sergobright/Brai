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

  prepareBraiCmdPreliminaryProfile(input) {
    const displayName = normalizeDisplayName(input.displayName);
    const deviceFingerprint = normalizeDeviceFingerprint(input.deviceFingerprint);
    const deviceFingerprintHash = hashSecret(deviceFingerprint);
    const claimToken = cleanMetadata(input.preliminaryClaimToken);
    const claimTokenHash = claimToken ? hashSecret(claimToken) : '';
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM preliminary_users WHERE device_fingerprint_hash = ?')
        .get(deviceFingerprintHash);
      if (existing) {
        if (existing.status === 'active' && claimTokenHash && safeEqualHex(existing.claim_token_hash, claimTokenHash)) {
          this.db.prepare(`
            UPDATE preliminary_users
            SET display_name = ?,
                install_id_hash = CASE WHEN ? <> '' THEN ? ELSE install_id_hash END,
                updated_at_utc = ?,
                last_seen_at_utc = ?,
                client_version = CASE WHEN ? <> '' THEN ? ELSE client_version END,
                app_package = CASE WHEN ? <> '' THEN ? ELSE app_package END
            WHERE id = ?
          `).run(
            displayName,
            hashOptionalSecret(input.deviceId),
            hashOptionalSecret(input.deviceId),
            now,
            now,
            cleanMetadata(input.clientVersion),
            cleanMetadata(input.clientVersion),
            cleanMetadata(input.appPackage),
            cleanMetadata(input.appPackage),
            existing.id
          );
          return {
            status: 'ready',
            preliminaryClaimToken: claimToken,
            row: {
              ...existing,
              display_name: displayName,
              updated_at_utc: now,
              last_seen_at_utc: now,
              client_version: cleanMetadata(input.clientVersion) || existing.client_version,
              app_package: cleanMetadata(input.appPackage) || existing.app_package
            }
          };
        }
        return { status: 'duplicate', row: existing };
      }

      const preliminaryClaimToken = `pc_${randomBytes(32).toString('base64url')}`;
      const row = {
        id: randomUUID(),
        display_name: displayName,
        device_fingerprint_hash: deviceFingerprintHash,
        device_fingerprint_kind: cleanMetadata(input.deviceFingerprintKind) || 'android_id',
        install_id_hash: hashOptionalSecret(input.deviceId),
        claim_token_hash: hashSecret(preliminaryClaimToken),
        status: 'active',
        user_id: null,
        created_at_utc: now,
        updated_at_utc: now,
        last_seen_at_utc: now,
        converted_at_utc: null,
        client_version: cleanMetadata(input.clientVersion),
        app_package: cleanMetadata(input.appPackage)
      };
      this.db.prepare(`
        INSERT INTO preliminary_users (
          id, display_name, device_fingerprint_hash, device_fingerprint_kind,
          install_id_hash, claim_token_hash, status, user_id, created_at_utc,
          updated_at_utc, last_seen_at_utc, converted_at_utc, client_version, app_package
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.display_name,
        row.device_fingerprint_hash,
        row.device_fingerprint_kind,
        row.install_id_hash,
        row.claim_token_hash,
        row.status,
        row.user_id,
        row.created_at_utc,
        row.updated_at_utc,
        row.last_seen_at_utc,
        row.converted_at_utc,
        row.client_version,
        row.app_package
      );
      return { status: 'ready', preliminaryClaimToken, row };
    });
    const result = run();
    safeRecordLog(this, {
      dt: now,
      source: 'brai-cmd',
      operation: 'brai_cmd.preliminary_profile',
      status: result.status === 'ready' ? 'done' : 'failed',
      severityText: result.status === 'ready' ? 'INFO' : 'WARN',
      reason: result.status === 'duplicate' ? 'duplicate_device' : null,
      message: result.status === 'ready' ? 'Brai Cmd preliminary profile ready' : 'Brai Cmd preliminary profile rejected',
      jsonData: {
        preliminary_users_id: result.row.id,
        duplicate_device: result.status === 'duplicate',
        status: result.row.status,
        client_version_present: Boolean(cleanMetadata(input.clientVersion)),
        app_package_present: Boolean(cleanMetadata(input.appPackage))
      }
    });
    return formatPreliminaryResult(result);
  },

  resolveBraiCmdPreliminaryForAccess(input) {
    const deviceFingerprint = optionalDeviceFingerprint(input.deviceFingerprint);
    if (!deviceFingerprint) return { ok: true, preliminaryUsersId: null };
    const deviceFingerprintHash = hashSecret(deviceFingerprint);
    const preliminaryUserId = cleanMetadata(input.preliminaryUserId);
    const preliminaryClaimToken = cleanMetadata(input.preliminaryClaimToken);
    const row = (preliminaryUserId
      ? this.db.prepare('SELECT * FROM preliminary_users WHERE id = ?').get(preliminaryUserId)
      : null) ?? this.db
        .prepare('SELECT * FROM preliminary_users WHERE device_fingerprint_hash = ?')
        .get(deviceFingerprintHash);

    if (!row) {
      return { ok: false, status: 400, code: 'preliminary_profile_required', message: 'Создайте предварительный профиль' };
    }
    if (!safeEqualHex(row.device_fingerprint_hash, deviceFingerprintHash)) {
      return { ok: false, status: 409, code: 'duplicate_device', message: 'Повторная регистрация невозможна. Войдите в профиль по email.' };
    }
    const claimMatches = preliminaryClaimToken && safeEqualHex(row.claim_token_hash, hashSecret(preliminaryClaimToken));
    if (row.status === 'active' && !claimMatches) {
      return { ok: false, status: 409, code: 'duplicate_device', message: 'Повторная регистрация невозможна. Войдите в профиль по email.', preliminaryUserId: row.id };
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE preliminary_users
      SET last_seen_at_utc = ?,
          updated_at_utc = ?,
          client_version = CASE WHEN ? <> '' THEN ? ELSE client_version END,
          app_package = CASE WHEN ? <> '' THEN ? ELSE app_package END
      WHERE id = ?
    `).run(
      now,
      now,
      cleanMetadata(input.clientVersion),
      cleanMetadata(input.clientVersion),
      cleanMetadata(input.appPackage),
      cleanMetadata(input.appPackage),
      row.id
    );
    return { ok: true, preliminaryUsersId: row.id };
  },

  finalizeBraiCmdPreliminaryUser(input) {
    const userId = cleanMetadata(input.userId);
    if (!userId) return { linked: false, reason: 'user_required' };
    const preliminaryUserId = cleanMetadata(input.preliminaryUserId);
    const preliminaryClaimToken = cleanMetadata(input.preliminaryClaimToken);
    const deviceFingerprint = optionalDeviceFingerprint(input.deviceFingerprint);
    const deviceFingerprintHash = deviceFingerprint ? hashSecret(deviceFingerprint) : '';
    if (!preliminaryUserId && !preliminaryClaimToken && !deviceFingerprintHash) {
      return { linked: false, reason: 'preliminary_context_missing' };
    }

    const now = cleanMetadata(input.nowIso) || new Date().toISOString();
    const run = this.db.transaction(() => {
      const row = (preliminaryUserId
        ? this.db.prepare('SELECT * FROM preliminary_users WHERE id = ?').get(preliminaryUserId)
        : null) ?? (deviceFingerprintHash
          ? this.db.prepare('SELECT * FROM preliminary_users WHERE device_fingerprint_hash = ?').get(deviceFingerprintHash)
          : null);
      if (!row) return { linked: false, reason: 'not_found' };
      const claimMatches = preliminaryClaimToken && safeEqualHex(row.claim_token_hash, hashSecret(preliminaryClaimToken));
      const fingerprintMatches = deviceFingerprintHash && safeEqualHex(row.device_fingerprint_hash, deviceFingerprintHash);
      if (!claimMatches && !fingerprintMatches) return { linked: false, reason: 'not_authorized', row };
      if (row.user_id && row.user_id !== userId) return { linked: false, reason: 'already_linked', row };

      this.db.prepare(`
        UPDATE preliminary_users
        SET status = 'converted',
            user_id = ?,
            converted_at_utc = COALESCE(converted_at_utc, ?),
            updated_at_utc = ?,
            last_seen_at_utc = ?
        WHERE id = ?
      `).run(userId, now, now, now, row.id);
      return {
        linked: row.status !== 'converted' || row.user_id !== userId,
        reason: row.status === 'converted' ? 'already_converted' : 'converted',
        row: { ...row, status: 'converted', user_id: userId, converted_at_utc: row.converted_at_utc ?? now }
      };
    });
    const result = run();
    if (result.linked) {
      safeRecordLog(this, {
        dt: now,
        source: 'brai-cmd',
        operation: 'brai_cmd.preliminary_finalize',
        status: 'done',
        userId,
        message: 'Brai Cmd preliminary profile linked to auth user',
        jsonData: { preliminary_users_id: result.row.id, previous_status: result.reason }
      });
    }
    return {
      linked: result.linked,
      reason: result.reason,
      preliminaryUserId: result.row?.id ?? null,
      displayName: result.row?.display_name ?? null
    };
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
      appPackage: cleanMetadata(input.appPackage),
      preliminaryUsersId: cleanMetadata(input.preliminaryUsersId)
    };
    this.db.prepare(`
      INSERT INTO brai_cmd_access_tokens (
        id, display_name, token_hash, device_id_hash, status, source,
        created_at_utc, activated_at_utc, last_used_at_utc, client_version, app_package,
        preliminary_users_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.appPackage,
      record.preliminaryUsersId || null
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
        preliminary_users_id: record.preliminaryUsersId || null,
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
      LEFT JOIN "user" au ON au.id = p.user_id
      GROUP BY t.id, p.id, au.id
      ORDER BY t.created_at_utc DESC
    `).all().map((row) => formatAdminToken(row));
    const totals = tokens.reduce((acc, token) => addUsage(acc, token.usage), emptyUsage());
    const preliminaryTotals = tokens
      .filter((token) => token.owner.type === 'preliminary')
      .reduce((acc, token) => addUsage(acc, token.usage), emptyUsage());
    const registeredTotals = tokens
      .filter((token) => token.owner.type === 'registered')
      .reduce((acc, token) => addUsage(acc, token.usage), emptyUsage());
    const legacyTotals = tokens
      .filter((token) => token.owner.type === 'legacy')
      .reduce((acc, token) => addUsage(acc, token.usage), emptyUsage());
    return {
      settings: this.braiCmdSettings(),
      totals: {
        ...totals,
        activeTokens: tokens.filter((token) => token.status === 'active').length,
        revokedTokens: tokens.filter((token) => token.status === 'revoked').length,
        preliminaryTokens: tokens.filter((token) => token.owner.type === 'preliminary').length,
        registeredTokens: tokens.filter((token) => token.owner.type === 'registered').length,
        legacyTokens: tokens.filter((token) => token.owner.type === 'legacy').length,
        preliminaryUsage: preliminaryTotals,
        registeredUsage: registeredTotals,
        legacyUsage: legacyTotals
      },
      tokens,
      recentUsage: this.db.prepare(`
        SELECT u.*,
               t.display_name,
               t.preliminary_users_id,
               p.status AS preliminary_status,
               p.user_id AS preliminary_user_id,
               p.display_name AS preliminary_display_name,
               au.email AS auth_user_email,
               au.name AS auth_user_name
        FROM brai_cmd_usage_events u
        LEFT JOIN brai_cmd_access_tokens t ON t.id = u.access_token_id
        LEFT JOIN preliminary_users p ON p.id = t.preliminary_users_id
        LEFT JOIN "user" au ON au.id = p.user_id
        ORDER BY u.created_at_utc DESC
        LIMIT 50
      `).all().map((row) => ({
        id: row.id,
        displayName: row.display_name ?? 'Unknown',
        owner: adminOwner(row),
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
    preliminaryUsersId: row.preliminary_users_id,
    status: row.status,
    source: row.source,
    createdAt: row.created_at_utc,
    activatedAt: row.activated_at_utc,
    lastUsedAt: row.last_used_at_utc,
    clientVersion: row.client_version,
    appPackage: row.app_package
  };
}

function formatAdminToken(row) {
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
    owner: adminOwner(row),
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
  };
}

function adminOwner(row) {
  if (!row.preliminary_users_id) return { type: 'legacy', label: 'Legacy access token' };
  if (row.preliminary_status === 'converted' && row.preliminary_user_id) {
    return {
      type: 'registered',
      preliminaryUserId: row.preliminary_users_id,
      userId: row.preliminary_user_id,
      label: row.auth_user_email || row.auth_user_name || row.preliminary_display_name || 'Registered user',
      email: row.auth_user_email || null,
      name: row.auth_user_name || null
    };
  }
  return {
    type: 'preliminary',
    preliminaryUserId: row.preliminary_users_id,
    label: row.preliminary_display_name || 'Preliminary user'
  };
}

function formatPreliminaryResult(result) {
  return {
    status: result.status,
    preliminaryUserId: result.row.id,
    preliminaryClaimToken: result.status === 'ready' ? result.preliminaryClaimToken : null,
    displayName: result.row.display_name,
    userId: result.row.user_id ?? null
  };
}

function hashSecret(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashOptionalSecret(value) {
  const clean = String(value ?? '').trim();
  return clean ? hashSecret(clean) : '';
}

function normalizeDeviceFingerprint(value) {
  const clean = optionalDeviceFingerprint(value);
  if (!clean) throw new Error('device_fingerprint_required');
  return clean;
}

function optionalDeviceFingerprint(value) {
  return String(value ?? '').trim().slice(0, 240);
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
