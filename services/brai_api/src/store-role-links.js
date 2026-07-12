import { sanitizeText } from './store-helpers.js';
import { scopeSql, scopedUserId } from './user-scope.js';

const ROLE_CONTRACTS = {
  activity: {
    titleSystem: 'activity',
    payloadTable: 'activities',
    eventDomain: 'activity',
    subjectType: 'activity',
    defaultTitle: 'Activity'
  },
  focus_session: {
    titleSystem: 'focus_session',
    payloadTable: 'focus_sessions',
    eventDomain: 'timer',
    subjectType: 'focus_session',
    defaultTitle: 'Focus session'
  }
};

export const roleLinkMethods = {
  ensureActivityRoleLink(activity) {
    return this.ensureEntityRoleLink({
      roleType: 'activity',
      id: activity.id,
      title: activity.title,
      description: activity.description_md,
      author: activity.author,
      createdAtUtc: activity.created_at_utc,
      updatedAtUtc: activity.updated_at_utc,
      deletedAtUtc: activity.deleted_at_utc,
      userId: scopedUserId()
    });
  },

  ensureFocusSessionRoleLink(session) {
    return this.ensureEntityRoleLink({
      roleType: 'focus_session',
      id: session.id,
      title: 'Focus session',
      description: '',
      author: '',
      createdAtUtc: session.created_at_utc,
      updatedAtUtc: session.updated_at_utc,
      deletedAtUtc: session.deleted_at_utc,
      userId: session.user_id ?? scopedUserId()
    });
  },

  ensureEntityRoleLink(input) {
    const contract = ROLE_CONTRACTS[input.roleType];
    if (!contract) throw new Error(`unknown_role_type:${input.roleType}`);
    const id = sanitizeText(input.id);
    if (!id) throw new Error('role_payload_id_required');
    const now = input.updatedAtUtc ?? input.createdAtUtc ?? new Date().toISOString();
    const createdAt = input.createdAtUtc ?? now;
    const deletedAt = input.deletedAtUtc ?? null;
    const status = deletedAt ? 'deleted' : 'active';
    const title = sanitizeText(input.title) ?? contract.defaultTitle;
    const author = sanitizeText(input.author) ?? '';
    const description = typeof input.description === 'string' ? input.description : '';
    const userId = input.userId ?? null;
    const roleType = this.db
      .prepare('SELECT id FROM item_role_types WHERE title_system = ? AND deleted_at_utc IS NULL')
      .get(contract.titleSystem);
    if (!roleType) throw new Error(`role_type_missing:${contract.titleSystem}`);

    this.db.prepare(`
      INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc, deleted_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = COALESCE(items.user_id, excluded.user_id),
        title = excluded.title,
        description = excluded.description,
        author = excluded.author,
        updated_at_utc = excluded.updated_at_utc,
        deleted_at_utc = excluded.deleted_at_utc
      WHERE items.user_id IS NOT DISTINCT FROM excluded.user_id
        OR items.user_id IS NULL
        OR excluded.user_id IS NULL
    `).run(id, userId, title, description, author, createdAt, now, deletedAt);

    const item = this.db
      .prepare('SELECT id FROM items WHERE id = ? AND (user_id IS NOT DISTINCT FROM ? OR user_id IS NULL OR ?::text IS NULL)')
      .get(id, userId, userId);
    if (!item) throw new Error('item_scope_conflict');

    const linkedRoleId = this.db
      .prepare(`SELECT item_roles_id FROM ${contract.payloadTable} WHERE id = ?`)
      .get(id)?.item_roles_id ?? null;
    const reusableRoleId = linkedRoleId ?? this.db.prepare(`
      SELECT id
      FROM item_roles
      WHERE items_id = ? AND item_role_types_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'ended' THEN 1 ELSE 2 END, id ASC
      LIMIT 1
    `).get(id, roleType.id)?.id ?? null;
    const roleId = reusableRoleId ?? this.db.prepare(`
      INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, active_to_utc, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, '{}')
      RETURNING id
    `).get(id, roleType.id, createdAt, deletedAt, status).id;

    this.db.prepare(`
      UPDATE item_roles
      SET active_from_utc = COALESCE(active_from_utc, ?),
        active_to_utc = ?,
        status = ?
      WHERE id = ?
    `).run(createdAt, deletedAt, status, roleId);

    const linked = this.db
      .prepare(`UPDATE ${contract.payloadTable} SET item_roles_id = ? WHERE id = ? AND (item_roles_id IS NULL OR item_roles_id = ?)`)
      .run(roleId, id, roleId);
    if (linked.changes !== 1) throw new Error('role_payload_link_conflict');

    this.db.prepare(`
      UPDATE events
      SET items_id = ?, item_roles_id = ?
      WHERE event_domain = ?
        AND subject_type = ?
        AND subject_id = ?
        AND status = 'accepted'
        AND (item_roles_id IS NULL OR item_roles_id = ?)
    `).run(id, roleId, contract.eventDomain, contract.subjectType, id, roleId);

    return { items_id: id, item_roles_id: roleId };
  },

  syncFocusSessionRoleLinks(nowIso) {
    const scope = scopeSql('s');
    const sessions = this.db.prepare(`
      SELECT s.id, s.created_at_utc, COALESCE(s.updated_at_utc, ?) AS updated_at_utc, s.deleted_at_utc, s.user_id
      FROM focus_sessions s
      WHERE 1 = 1
        ${scope.clause}
      ORDER BY s.created_at_utc ASC, s.id ASC
    `).all(nowIso, ...scope.params);
    for (const session of sessions) {
      this.ensureFocusSessionRoleLink(session);
    }
  }
};
