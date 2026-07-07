import { scopedUserId } from './user-scope.js';
import { originalNameForImagePreview } from './inbox.js';

const OWNED_TABLES = [
  'activities',
  'activity_events',
  'events',
  'inbox',
  'inbox_events',
  'logs',
  'timer_events',
  'focus_sessions',
  'focus_session_intervals'
];

export const authUserMethods = {
  primaryUserId() {
    return this.db
      .prepare("SELECT value FROM app_settings WHERE key = 'primary_user_id'")
      .get()?.value ?? null;
  }
,

  primaryUser() {
    const id = this.primaryUserId();
    return id ? this.getAuthUser(id) : null;
  }
,

  getAuthUser(userId) {
    if (!userId) return null;
    return this.db
      .prepare('SELECT id, name, email, "emailVerified" AS emailVerified FROM "user" WHERE id = ?')
      .get(userId) ?? null;
  }
,

  claimFirstUser(userId, nowIso = new Date().toISOString()) {
    if (!this.getAuthUser(userId)) {
      const error = new Error('auth_user_not_found');
      error.status = 400;
      throw error;
    }

    const run = this.db.transaction(() => {
      const existing = this.primaryUserId();
      if (existing) return existing;

      this.db
        .prepare(`
          INSERT INTO app_settings (key, value, updated_at_utc)
          VALUES ('primary_user_id', ?, ?)
          ON CONFLICT(key) DO NOTHING
        `)
        .run(userId, nowIso);

      const claimed = this.primaryUserId();
      if (claimed !== userId) return claimed;
      for (const table of OWNED_TABLES) {
        this.db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(userId);
      }
      return userId;
    });
    return run();
  }
,

  canReadInboxAttachment(name) {
    const userId = scopedUserId();
    if (!userId) return true;
    const link = `/v1/inbox/attachments/${name}`;
    const originalName = originalNameForImagePreview(name);
    const originalLink = originalName ? `/v1/inbox/attachments/${originalName}` : null;
    const rows = this.db
      .prepare(`
        SELECT attachment_links_json
        FROM inbox
        WHERE user_id = ?
          AND deleted_at_utc IS NULL
      `)
      .all(userId);
    // ponytail: attachment rows are small; switch to a normalized attachment table when volume matters.
    return rows.some((row) => {
      const links = parseLinks(row.attachment_links_json);
      return links.includes(link) || (originalLink ? links.includes(originalLink) : false);
    });
  }
};

function parseLinks(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
