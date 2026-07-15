INSERT INTO activities (
  id,
  activity_type_id,
  title,
  description_md,
  author,
  reason,
  status,
  created_at_utc,
  updated_at_utc
) VALUES (
  'preview:seed:supabase-ready',
  'operation',
  'Preview Supabase seed',
  'Deterministic marker row proving this preview database was seeded after branch creation.',
  'System',
  'Preview environments must have their own Supabase branch and test seed data.',
  'New',
  '2026-07-06T00:00:00.000Z',
  '2026-07-06T00:00:00.000Z'
)
ON CONFLICT (id) DO UPDATE SET
  activity_type_id = EXCLUDED.activity_type_id,
  title = EXCLUDED.title,
  description_md = EXCLUDED.description_md,
  author = EXCLUDED.author,
  reason = EXCLUDED.reason,
  status = EXCLUDED.status,
  updated_at_utc = EXCLUDED.updated_at_utc;
