-- brai:reapply-after-production-seed

INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc, deleted_at_utc)
SELECT id, user_id, title, description_md, author, created_at_utc, updated_at_utc, deleted_at_utc
FROM activities
WHERE item_roles_id IS NULL
ON CONFLICT (id) DO UPDATE SET
  user_id = COALESCE(items.user_id, excluded.user_id),
  title = excluded.title,
  description = excluded.description,
  author = excluded.author,
  updated_at_utc = excluded.updated_at_utc,
  deleted_at_utc = excluded.deleted_at_utc
WHERE items.user_id IS NOT DISTINCT FROM excluded.user_id
  OR items.user_id IS NULL
  OR excluded.user_id IS NULL;

INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, active_to_utc, status, metadata_json)
SELECT a.id, rt.id, a.created_at_utc, a.deleted_at_utc,
  CASE WHEN a.deleted_at_utc IS NULL THEN 'active' ELSE 'deleted' END,
  '{}'
FROM activities a
JOIN item_role_types rt ON rt.title_system = 'activity' AND rt.deleted_at_utc IS NULL
WHERE a.item_roles_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM item_roles r
    WHERE r.items_id = a.id
      AND r.item_role_types_id = rt.id
  );

UPDATE activities a
SET item_roles_id = r.id
FROM item_roles r
JOIN item_role_types rt ON rt.id = r.item_role_types_id
WHERE a.item_roles_id IS NULL
  AND r.items_id = a.id
  AND rt.title_system = 'activity';

UPDATE item_roles r
SET active_to_utc = a.deleted_at_utc,
  status = CASE WHEN a.deleted_at_utc IS NULL THEN 'active' ELSE 'deleted' END
FROM activities a, item_role_types rt
WHERE a.item_roles_id = r.id
  AND rt.id = r.item_role_types_id
  AND rt.title_system = 'activity';

INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc, deleted_at_utc)
SELECT id, user_id, 'Focus session', '', '', created_at_utc, updated_at_utc, deleted_at_utc
FROM focus_sessions
WHERE item_roles_id IS NULL
ON CONFLICT (id) DO UPDATE SET
  user_id = COALESCE(items.user_id, excluded.user_id),
  title = excluded.title,
  description = excluded.description,
  author = excluded.author,
  updated_at_utc = excluded.updated_at_utc,
  deleted_at_utc = excluded.deleted_at_utc
WHERE items.user_id IS NOT DISTINCT FROM excluded.user_id
  OR items.user_id IS NULL
  OR excluded.user_id IS NULL;

INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, active_to_utc, status, metadata_json)
SELECT f.id, rt.id, f.created_at_utc, f.deleted_at_utc,
  CASE WHEN f.deleted_at_utc IS NULL THEN 'active' ELSE 'deleted' END,
  '{}'
FROM focus_sessions f
JOIN item_role_types rt ON rt.title_system = 'focus_session' AND rt.deleted_at_utc IS NULL
WHERE f.item_roles_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM item_roles r
    WHERE r.items_id = f.id
      AND r.item_role_types_id = rt.id
  );

UPDATE focus_sessions f
SET item_roles_id = r.id
FROM item_roles r
JOIN item_role_types rt ON rt.id = r.item_role_types_id
WHERE f.item_roles_id IS NULL
  AND r.items_id = f.id
  AND rt.title_system = 'focus_session';

UPDATE item_roles r
SET active_to_utc = f.deleted_at_utc,
  status = CASE WHEN f.deleted_at_utc IS NULL THEN 'active' ELSE 'deleted' END
FROM focus_sessions f, item_role_types rt
WHERE f.item_roles_id = r.id
  AND rt.id = r.item_role_types_id
  AND rt.title_system = 'focus_session';

UPDATE inbox
SET is_normalized = 1
WHERE item_roles_id IS NOT NULL
  AND is_normalized = 0;

UPDATE events e
SET items_id = a.id,
  item_roles_id = a.item_roles_id
FROM activities a
WHERE e.event_domain = 'activity'
  AND e.subject_type = 'activity'
  AND e.subject_id = a.id
  AND e.status = 'accepted'
  AND a.item_roles_id IS NOT NULL
  AND e.item_roles_id IS NULL;

UPDATE events e
SET items_id = f.id,
  item_roles_id = f.item_roles_id
FROM focus_sessions f
WHERE e.event_domain = 'timer'
  AND e.subject_type = 'focus_session'
  AND e.subject_id = f.id
  AND e.status = 'accepted'
  AND f.item_roles_id IS NOT NULL
  AND e.item_roles_id IS NULL;

UPDATE events e
SET items_id = i.id,
  item_roles_id = i.item_roles_id
FROM inbox i
WHERE e.event_domain = 'inbox'
  AND e.subject_type = 'inbox'
  AND e.subject_id = i.id
  AND e.status = 'accepted'
  AND i.item_roles_id IS NOT NULL
  AND e.item_roles_id IS NULL;

DELETE FROM item_roles r
USING item_role_types rt
WHERE rt.id = r.item_role_types_id
  AND rt.title_system IN ('activity', 'inbox', 'focus_session')
  AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.item_roles_id = r.id OR (rt.title_system = 'activity' AND a.id = r.items_id))
  AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.item_roles_id = r.id OR (rt.title_system = 'inbox' AND i.id = r.items_id))
  AND NOT EXISTS (SELECT 1 FROM focus_sessions f WHERE f.item_roles_id = r.id OR (rt.title_system = 'focus_session' AND f.id = r.items_id))
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.item_roles_id = r.id OR e.items_id = r.items_id);

DELETE FROM items i
WHERE NOT EXISTS (SELECT 1 FROM item_roles r WHERE r.items_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.id = i.id)
  AND NOT EXISTS (SELECT 1 FROM inbox x WHERE x.id = i.id)
  AND NOT EXISTS (SELECT 1 FROM focus_sessions f WHERE f.id = i.id)
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.items_id = i.id);

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (58, now()::text, 'repair entity role links for activities and focus sessions')
ON CONFLICT (version) DO NOTHING;
