ALTER TABLE inbox_classes ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (49, now()::text, 'enable RLS for Inbox classes')
ON CONFLICT (version) DO NOTHING;
