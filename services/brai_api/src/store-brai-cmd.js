import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const ACCOUNT_LINK_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_BRAI_CMD_MESSAGES = Object.freeze({
  'message.inbox.created.default': 'Отправлено во входящие',
  'message.inbox.duplicate.default': 'Уже во входящих',
  'message.dictate.success.main': '',
  'message.function.disabled.default': 'Функция временно недоступна'
});

const DEFAULT_BRAI_CMD_FUNCTIONS = Object.freeze({
  main_dictation: { key: 'main_dictation', title: 'Диктовка голос в текст', enabled: true },
  idea_voice_inbox: { key: 'idea_voice_inbox', title: 'Идея голосом во входящие', enabled: true },
  screenshot_inbox: { key: 'screenshot_inbox', title: 'Скриншот во входящие', enabled: true },
  screenshot_voice_inbox: { key: 'screenshot_voice_inbox', title: 'Скриншот и голос во входящие', enabled: true },
  chat_context_inbox: { key: 'chat_context_inbox', title: 'JSON чата и голос во входящие', enabled: true },
  save_context_inbox: { key: 'save_context_inbox', title: 'Сохранить JSON и голос во входящие', enabled: true }
});

export const braiCmdStoreMethods = {
  braiCmdSettings() {
    const row = this.db.prepare("SELECT value FROM brai_cmd_settings WHERE key = 'registration_enabled'").get();
    return {
      registrationEnabled: row?.value !== 'false',
      messages: this.braiCmdMessages(),
      functions: this.braiCmdFunctions()
    };
  },

  braiCmdMessages() {
    const rows = this.db.prepare("SELECT key, value FROM brai_cmd_settings WHERE key LIKE 'message.%'").all();
    const saved = Object.fromEntries(rows.map((row) => [row.key, cleanNoticeText(row.value)]));
    return { ...DEFAULT_BRAI_CMD_MESSAGES, ...saved };
  },

  braiCmdNotice(key, tone = 'success') {
    const text = this.braiCmdMessages()[key] ?? DEFAULT_BRAI_CMD_MESSAGES[key] ?? '';
    const clean = cleanNoticeText(text);
    return clean ? { key, text: clean, tone: cleanNoticeTone(tone) } : null;
  },

  braiCmdFunctions() {
    const rows = this.db.prepare("SELECT key, value FROM brai_cmd_settings WHERE key LIKE 'function.%.enabled'").all();
    const saved = new Map();
    for (const row of rows) {
      const key = functionKeyFromSettingKey(row.key);
      if (key && Object.hasOwn(DEFAULT_BRAI_CMD_FUNCTIONS, key)) {
        saved.set(key, row.value !== 'false');
      }
    }
    return Object.fromEntries(Object.entries(DEFAULT_BRAI_CMD_FUNCTIONS).map(([key, value]) => [
      key,
      { ...value, enabled: saved.has(key) ? saved.get(key) : value.enabled }
    ]));
  },

  braiCmdFunctionEnabled(key) {
    const normalized = cleanFunctionKey(key);
    if (!Object.hasOwn(DEFAULT_BRAI_CMD_FUNCTIONS, normalized)) return false;
    return this.braiCmdFunctions()[normalized]?.enabled !== false;
  },

  setBraiCmdRegistrationEnabled(registrationEnabled) {
    return this.setBraiCmdSettings({ registrationEnabled });
  },

  setBraiCmdSettings({ registrationEnabled, messages, functions } = {}) {
    const now = new Date().toISOString();
    const touched = {};
    if (registrationEnabled !== undefined) {
      this.db.prepare(`
        INSERT INTO brai_cmd_settings (key, value, updated_at_utc)
        VALUES ('registration_enabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at_utc = excluded.updated_at_utc
      `).run(registrationEnabled ? 'true' : 'false', now);
      touched.registration_enabled = Boolean(registrationEnabled);
    }
    if (messages && typeof messages === 'object' && !Array.isArray(messages)) {
      const upsert = this.db.prepare(`
        INSERT INTO brai_cmd_settings (key, value, updated_at_utc)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at_utc = excluded.updated_at_utc
      `);
      for (const [key, value] of Object.entries(messages)) {
        if (!Object.hasOwn(DEFAULT_BRAI_CMD_MESSAGES, key)) continue;
        upsert.run(key, cleanNoticeText(value), now);
        touched[key] = true;
      }
    }
    if (functions && typeof functions === 'object' && !Array.isArray(functions)) {
      const upsert = this.db.prepare(`
        INSERT INTO brai_cmd_settings (key, value, updated_at_utc)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at_utc = excluded.updated_at_utc
      `);
      for (const [key, value] of Object.entries(functions)) {
        const normalized = cleanFunctionKey(key);
        if (!Object.hasOwn(DEFAULT_BRAI_CMD_FUNCTIONS, normalized)) continue;
        const enabled = cleanFunctionEnabled(value);
        if (enabled === null) continue;
        const settingKey = `function.${normalized}.enabled`;
        upsert.run(settingKey, enabled ? 'true' : 'false', now);
        touched[settingKey] = enabled;
      }
    }
    if (Object.keys(touched).length === 0) return this.braiCmdSettings();
    this.db.prepare(`
      INSERT INTO brai_cmd_settings (key, value, updated_at_utc)
      VALUES ('messages_revision', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at_utc = excluded.updated_at_utc
    `).run(now, now);
    safeRecordLog(this, {
      source: 'brai-cmd',
      operation: 'brai_cmd.admin_settings_update',
      status: 'done',
      message: 'Brai Cmd admin settings updated',
      jsonData: touched
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
    const issued = buildBraiCmdAccess(input);
    const { record } = issued;
    this.db.transaction(() => {
      if (record.userId && record.deviceIdHash) {
        this.db.prepare(`
          UPDATE brai_cmd_access_tokens
          SET status = 'revoked'
          WHERE user_id = ? AND device_id_hash = ? AND status = 'active'
        `).run(record.userId, record.deviceIdHash);
      }
      insertBraiCmdAccess(this, record);
    })();
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
        user_id: record.userId,
        client_version_present: Boolean(record.clientVersion),
        app_package_present: Boolean(record.appPackage)
      }
    });
    return issued;
  },

  issueBraiCmdAccountLink(input) {
    const userId = cleanMetadata(input.userId);
    const deviceId = String(input.deviceId ?? '').trim();
    if (!userId) throw braiCmdTokenError('account_required', 403);
    if (!deviceId) throw braiCmdTokenError('device_id_required', 400);
    const token = `bl_${randomBytes(32).toString('base64url')}`;
    const createdAt = cleanIso(input.nowIso);
    const record = {
      id: randomUUID(),
      tokenHash: hashSecret(token),
      userId,
      deviceIdHash: hashSecret(deviceId),
      displayName: normalizeDisplayName(input.displayName),
      clientVersion: cleanMetadata(input.clientVersion),
      appPackage: cleanMetadata(input.appPackage),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ACCOUNT_LINK_TTL_MS).toISOString(),
      usedAt: null
    };
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE brai_cmd_account_link_tokens
        SET used_at_utc = ?
        WHERE device_id_hash = ? AND used_at_utc IS NULL
      `).run(createdAt, record.deviceIdHash);
      this.db.prepare(`
        INSERT INTO brai_cmd_account_link_tokens (
          id, token_hash, user_id, device_id_hash, display_name,
          client_version, app_package, created_at_utc, expires_at_utc, used_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.tokenHash,
        record.userId,
        record.deviceIdHash,
        record.displayName,
        record.clientVersion,
        record.appPackage,
        record.createdAt,
        record.expiresAt,
        record.usedAt
      );
    })();
    safeRecordLog(this, {
      dt: createdAt,
      source: 'brai-cmd',
      operation: 'brai_cmd.account_link_issue',
      status: 'done',
      userId,
      message: 'Brai Cmd account link issued',
      jsonData: {
        account_link_id: record.id,
        device_bound: true,
        ttl_seconds: ACCOUNT_LINK_TTL_MS / 1000
      }
    });
    return { token, record };
  },

  activateBraiCmdAccountLink(input) {
    const linkToken = String(input.linkToken ?? '').trim();
    const currentAccess = input.currentAccess;
    if (!/^bl_[A-Za-z0-9_-]{43}$/.test(linkToken)) throw braiCmdTokenError('invalid_link_token', 401);
    if (!currentAccess?.id || !currentAccess.deviceIdHash) {
      throw braiCmdTokenError('invalid_device_access', 401);
    }
    const deviceIdHash = currentAccess.deviceIdHash;
    const nowIso = cleanIso(input.nowIso);
    const issued = buildBraiCmdAccess({
      displayName: 'Brai',
      deviceIdHash,
      source: 'authenticated',
      nowIso
    });
    let link;
    this.db.transaction(() => {
      const activeAccess = this.db.prepare(`
        SELECT status, device_id_hash, expires_at_utc
        FROM brai_cmd_access_tokens WHERE id = ?
      `).get(currentAccess.id);
      if (
        activeAccess?.status !== 'active'
        || Date.parse(activeAccess.expires_at_utc) <= Date.parse(nowIso)
        || !activeAccess.device_id_hash
        || !safeEqualHex(activeAccess.device_id_hash, deviceIdHash)
      ) {
        throw braiCmdTokenError('invalid_device_access', 401);
      }
      link = this.db.prepare(`
        SELECT * FROM brai_cmd_account_link_tokens WHERE token_hash = ?
      `).get(hashSecret(linkToken));
      if (!link) throw braiCmdTokenError('invalid_link_token', 401);
      if (link.used_at_utc) throw braiCmdTokenError('link_token_used', 409);
      if (link.expires_at_utc <= nowIso) throw braiCmdTokenError('link_token_expired', 401);
      if (!safeEqualHex(link.device_id_hash, deviceIdHash)) {
        throw braiCmdTokenError('link_device_mismatch', 403);
      }
      const consumed = this.db.prepare(`
        UPDATE brai_cmd_account_link_tokens
        SET used_at_utc = ?
        WHERE id = ? AND used_at_utc IS NULL AND expires_at_utc > ?
      `).run(nowIso, link.id, nowIso);
      if (consumed.changes !== 1) throw braiCmdTokenError('invalid_link_token', 401);
      issued.record.displayName = link.display_name;
      issued.record.userId = link.user_id;
      issued.record.clientVersion = link.client_version || issued.record.clientVersion;
      issued.record.appPackage = link.app_package || issued.record.appPackage;
      this.db.prepare(`
        UPDATE brai_cmd_access_tokens
        SET status = 'revoked'
        WHERE device_id_hash = ? AND status = 'active'
      `).run(deviceIdHash);
      insertBraiCmdAccess(this, issued.record);
    })();
    safeRecordLog(this, {
      dt: nowIso,
      source: 'brai-cmd',
      operation: 'brai_cmd.account_link_activate',
      status: 'done',
      userId: issued.record.userId,
      message: 'Brai Cmd account link activated',
      jsonData: {
        account_link_id: link.id,
        access_token_id: issued.record.id,
        replaced_access_token_id: currentAccess.id
      }
    });
    return issued;
  },

  authenticateBraiCmdAccess(token, deviceId, clientVersion = '') {
    const tokenHash = hashSecret(token.trim());
    const deviceIdHash = hashSecret(deviceId.trim());
    const rows = this.db.prepare(`
      SELECT * FROM brai_cmd_access_tokens
      WHERE status = 'active'
      ORDER BY created_at_utc
    `).all();
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const row = rows.find((candidate) => (
      Date.parse(candidate.expires_at_utc) > nowMs && safeEqualHex(candidate.token_hash, tokenHash)
    ));
    if (!row) return null;
    if (row.device_id_hash && !safeEqualHex(row.device_id_hash, deviceIdHash)) return null;

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
      postProcessingInputChars: safeNumber(input.postProcessingInputChars),
      postProcessingOutputChars: safeNumber(input.postProcessingOutputChars),
      clientVersion: cleanMetadata(input.clientVersion)
    };
    this.db.prepare(`
      INSERT INTO brai_cmd_usage_events (
        id, access_token_id, created_at_utc, success, error_code,
        audio_bytes, audio_duration_ms, provider, model, fallback_used,
        transcription_ms, post_processing_ms, total_ms, transcript_chars,
        post_processing_input_chars, post_processing_output_chars, client_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      row.postProcessingInputChars,
      row.postProcessingOutputChars,
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
        post_processing_input_chars: row.postProcessingInputChars,
        post_processing_output_chars: row.postProcessingOutputChars,
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
             COALESCE(SUM(u.post_processing_input_chars), 0) AS post_processing_input_chars,
             COALESCE(SUM(u.post_processing_output_chars), 0) AS post_processing_output_chars,
             COALESCE(SUM(u.transcription_ms), 0) AS transcription_ms,
             COALESCE(SUM(u.post_processing_ms), 0) AS post_processing_ms,
             COALESCE(SUM(u.total_ms), 0) AS total_ms
      FROM brai_cmd_access_tokens t
      LEFT JOIN brai_cmd_usage_events u ON u.access_token_id = t.id
      LEFT JOIN preliminary_users p ON p.id = t.preliminary_users_id
      LEFT JOIN "user" au ON au.id = COALESCE(t.user_id, p.user_id)
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
               t.user_id,
               au.email AS auth_user_email,
               au.name AS auth_user_name
        FROM brai_cmd_usage_events u
        LEFT JOIN brai_cmd_access_tokens t ON t.id = u.access_token_id
        LEFT JOIN preliminary_users p ON p.id = t.preliminary_users_id
        LEFT JOIN "user" au ON au.id = COALESCE(t.user_id, p.user_id)
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
        transcriptChars: row.transcript_chars,
        postProcessingInputChars: row.post_processing_input_chars,
        postProcessingOutputChars: row.post_processing_output_chars
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
    userId: row.user_id,
    status: row.status,
    source: row.source,
    createdAt: row.created_at_utc,
    expiresAt: row.expires_at_utc,
    activatedAt: row.activated_at_utc,
    lastUsedAt: row.last_used_at_utc,
    clientVersion: row.client_version,
    appPackage: row.app_package
  };
}

function buildBraiCmdAccess(input) {
  const token = `aw_${randomBytes(32).toString('base64url')}`;
  const now = cleanIso(input.nowIso);
  const deviceIdHash = input.deviceIdHash || (input.deviceId ? hashSecret(String(input.deviceId).trim()) : null);
  return {
    token,
    record: {
      id: randomUUID(),
      displayName: normalizeDisplayName(input.displayName),
      tokenHash: hashSecret(token),
      deviceIdHash,
      userId: cleanMetadata(input.userId) || null,
      status: 'active',
      source: input.source === 'admin' ? 'admin' : input.source === 'authenticated' ? 'authenticated' : 'self_service',
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + ACCESS_TOKEN_TTL_MS).toISOString(),
      activatedAt: deviceIdHash ? now : null,
      lastUsedAt: null,
      clientVersion: cleanMetadata(input.clientVersion),
      appPackage: cleanMetadata(input.appPackage),
      preliminaryUsersId: cleanMetadata(input.preliminaryUsersId)
    }
  };
}

function insertBraiCmdAccess(store, record) {
  store.db.prepare(`
    INSERT INTO brai_cmd_access_tokens (
      id, display_name, token_hash, device_id_hash, user_id, status, source,
      created_at_utc, expires_at_utc, activated_at_utc, last_used_at_utc, client_version, app_package,
      preliminary_users_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.displayName,
    record.tokenHash,
    record.deviceIdHash,
    record.userId,
    record.status,
    record.source,
    record.createdAt,
    record.expiresAt,
    record.activatedAt,
    record.lastUsedAt,
    record.clientVersion,
    record.appPackage,
    record.preliminaryUsersId || null
  );
}

function formatAdminToken(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    source: row.source,
    createdAt: row.created_at_utc,
    expiresAt: row.expires_at_utc,
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
  if (row.user_id) {
    return {
      type: 'registered',
      userId: row.user_id,
      label: row.auth_user_email || row.auth_user_name || row.display_name || 'Registered user',
      email: row.auth_user_email || null,
      name: row.auth_user_name || null
    };
  }
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

function cleanIso(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw braiCmdTokenError('invalid_timestamp', 500);
  return date.toISOString();
}

function braiCmdTokenError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function functionKeyFromSettingKey(key) {
  const value = String(key ?? '');
  if (!value.startsWith('function.') || !value.endsWith('.enabled')) return '';
  return cleanFunctionKey(value.slice('function.'.length, -'.enabled'.length));
}

function cleanFunctionKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 80);
}

function cleanFunctionEnabled(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const clean = value.trim().toLowerCase();
    if (clean === 'true') return true;
    if (clean === 'false') return false;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.enabled === 'boolean') {
    return value.enabled;
  }
  return null;
}

function safeNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function cleanNoticeText(value) {
  return String(value ?? '').trim().replace(/[.。．]+$/u, '').trim().slice(0, 120);
}

function cleanNoticeTone(value) {
  return ['success', 'warning', 'error', 'info'].includes(value) ? value : 'success';
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
    postProcessingInputChars: 0,
    postProcessingOutputChars: 0,
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
  left.postProcessingInputChars += right.postProcessingInputChars;
  left.postProcessingOutputChars += right.postProcessingOutputChars;
  left.transcriptionMs += right.transcriptionMs;
  left.postProcessingMs += right.postProcessingMs;
  left.totalMs += right.totalMs;
  return left;
}
