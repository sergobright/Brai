import { sanitizeText } from './store-helpers.js';
import { scopeSql, scopedUserId } from './user-scope.js';

const DEFAULT_RAIL_WIDTH = 256;

export const userContentMethods = {
  userPreferences() {
    const userId = scopedUserId();
    if (!userId) return { context_rail_width_px: DEFAULT_RAIL_WIDTH };
    const row = this.db.prepare(`
      SELECT context_rail_width_px
      FROM user_ui_preferences
      WHERE user_id = ?
    `).get(userId);
    return { context_rail_width_px: clampRailWidth(row?.context_rail_width_px) };
  },

  setUserPreferences(input, nowIso = new Date().toISOString()) {
    const userId = scopedUserId();
    if (!userId) throw statusError('auth_required', 401);
    const width = Number(input?.context_rail_width_px);
    if (!Number.isInteger(width) || width < 192 || width > 512) {
      throw statusError('invalid_context_rail_width', 400);
    }
    this.db.prepare(`
      INSERT INTO user_ui_preferences (user_id, context_rail_width_px, updated_at_utc)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        context_rail_width_px = excluded.context_rail_width_px,
        updated_at_utc = excluded.updated_at_utc
    `).run(userId, width, nowIso);
    this.recordLog?.({
      dt: nowIso,
      source: 'preferences',
      operation: 'preferences.update',
      status: 'done',
      message: 'User interface preferences updated',
      jsonData: { context_rail_width_px: width }
    });
    return { context_rail_width_px: width };
  },

  listArchive(roleSystem = 'activity') {
    const scope = scopeSql('i');
    const roles = this.db.prepare(`
      SELECT t.id, t.title_system, t.title, t.description, t.payload_table,
        COUNT(r.id) FILTER (WHERE i.id IS NOT NULL AND (i.deleted_at_utc IS NOT NULL OR r.status = 'deleted'))::integer AS archived_count
      FROM item_role_types t
      LEFT JOIN item_roles r ON r.item_role_types_id = t.id
      LEFT JOIN items i ON i.id = r.items_id ${scope.userId ? 'AND i.user_id = ?' : ''}
      WHERE t.deleted_at_utc IS NULL
      GROUP BY t.id, t.title_system, t.title, t.description, t.payload_table
      ORDER BY t.id ASC
    `).all(...scope.params);
    const selected = roles.find((role) => role.title_system === sanitizeText(roleSystem)) ?? roles[0] ?? null;
    return {
      roles,
      selected_role: selected?.title_system ?? null,
      items: selected ? this.listArchivedRoleItems(selected.title_system) : []
    };
  },

  listArchivedRoleItems(roleSystem) {
    const scope = scopeSql('i');
    const base = `
      SELECT i.id, i.title, i.description, i.author, i.created_at_utc, i.updated_at_utc,
        i.deleted_at_utc, r.id AS item_roles_id, r.status AS role_status,
        t.title_system AS role_system, t.title AS role_title
      FROM items i
      JOIN item_roles r ON r.items_id = i.id
      JOIN item_role_types t ON t.id = r.item_role_types_id
      WHERE t.title_system = ?
        AND (i.deleted_at_utc IS NOT NULL OR r.status = 'deleted')
        ${scope.clause}
      ORDER BY COALESCE(i.deleted_at_utc, r.active_to_utc, i.updated_at_utc) DESC, i.id ASC
    `;
    const items = this.db.prepare(base).all(roleSystem, ...scope.params);
    if (roleSystem === 'activity') return enrich(this, items, 'activities', 'description_md');
    if (roleSystem === 'inbox') return enrich(this, items, 'inbox', 'description_text');
    if (roleSystem === 'focus_session') {
      return items.map((item) => ({
        ...item,
        payload: this.db.prepare(`
          SELECT id, created_at_utc, updated_at_utc, deleted_at_utc, start_origin, started_by_activity_id
          FROM focus_sessions WHERE item_roles_id = ?
        `).get(item.item_roles_id) ?? null
      }));
    }
    return items.map((item) => ({ ...item, payload: null }));
  }
};

function enrich(store, items, table, descriptionColumn) {
  const allowed = table === 'activities'
    ? `id, activity_type_id, title, ${descriptionColumn} AS description_md, status, created_at_utc, updated_at_utc, completed_at_utc, deleted_at_utc, restored_at_utc`
    : `id, title, ${descriptionColumn} AS description_md, status, preliminary_section, created_at_utc, updated_at_utc, completed_at_utc, deleted_at_utc, restored_at_utc`;
  return items.map((item) => ({
    ...item,
    payload: store.db.prepare(`SELECT ${allowed} FROM ${table} WHERE item_roles_id = ?`).get(item.item_roles_id) ?? null
  }));
}

function clampRailWidth(value) {
  const width = Number(value);
  return Number.isInteger(width) ? Math.max(192, Math.min(512, width)) : DEFAULT_RAIL_WIDTH;
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
