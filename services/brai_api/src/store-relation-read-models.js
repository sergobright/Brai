export function readRelationTypes(db, userId) {
  const types = db.prepare(`
    SELECT * FROM relation_types
    WHERE is_system = 1 OR user_id = ?
    ORDER BY is_system DESC, key, id
  `).all(userId);
  const rulesByType = new Map(types.map((type) => [type.id, []]));
  const rules = db.prepare(`
    SELECT rules.*
    FROM relation_type_endpoint_rules rules
    JOIN relation_types types ON types.id = rules.relation_types_id
    WHERE types.is_system = 1 OR types.user_id = ?
    ORDER BY rules.relation_types_id, rules.id
  `).all(userId);
  for (const rule of rules) rulesByType.get(rule.relation_types_id)?.push(rule);
  return types.map((type) => ({ ...type, endpoint_rules: rulesByType.get(type.id) }));
}

export function readGoalMembers(db, userId, goalId) {
  const rows = db.prepare(`
    SELECT relations.id AS relation_id, relations.source_items_id AS items_id,
      relations.position, items.id AS endpoint_items_id, roles.id AS item_role_id,
      role_types.title_system AS role_key,
      activities.id AS activity_id, activities.activity_type_id,
      activities.status AS activity_status,
      activities.deleted_at_utc AS activity_deleted_at_utc,
      inbox.id AS inbox_id, inbox.preliminary_section, inbox.status AS inbox_status,
      inbox.is_normalized, inbox.deleted_at_utc AS inbox_deleted_at_utc
    FROM relations
    LEFT JOIN items ON items.id = relations.source_items_id
      AND items.user_id = relations.user_id AND items.deleted_at_utc IS NULL
    LEFT JOIN item_roles roles ON roles.items_id = items.id AND roles.status = 'active'
    LEFT JOIN item_role_types role_types ON role_types.id = roles.item_role_types_id
      AND role_types.deleted_at_utc IS NULL
    LEFT JOIN activities ON activities.item_roles_id = roles.id
    LEFT JOIN inbox ON inbox.item_roles_id = roles.id
    WHERE relations.user_id = ? AND relations.relation_types_id = 'part_of'
      AND relations.target_items_id = ? AND relations.status = 'active'
    ORDER BY relations.position NULLS LAST, relations.id, roles.id
  `).all(userId, goalId);
  const members = new Map();
  for (const row of rows) {
    const member = members.get(row.relation_id) ?? {
      relation_id: row.relation_id,
      items_id: row.items_id,
      role_key: null,
      type_key: null,
      status: null,
      position: row.position,
      valid: false,
      done: false,
      endpoint_valid: Boolean(row.endpoint_items_id),
      has_semantics: false
    };
    if (row.role_key === 'activity' && row.activity_id && !row.activity_deleted_at_utc) {
      member.has_semantics = true;
      if (!member.valid && row.activity_type_id === 'action') {
        Object.assign(member, {
          role_key: 'activity', type_key: 'action', status: row.activity_status,
          valid: true, done: row.activity_status === 'Done'
        });
      }
    }
    if (row.role_key === 'inbox' && row.inbox_id && !row.inbox_deleted_at_utc
      && row.is_normalized === 1 && row.preliminary_section === 'operation') {
      member.has_semantics = true;
      if (!member.valid) {
        Object.assign(member, {
          role_key: 'inbox', type_key: 'operation', status: row.inbox_status,
          valid: true, done: row.inbox_status === 'Done'
        });
      }
    }
    members.set(row.relation_id, member);
  }
  return [...members.values()];
}
