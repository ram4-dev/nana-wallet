-- Runtime repositories use this restricted role with transaction-local RLS context.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recipient_app') THEN
    CREATE ROLE recipient_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT recipient_app TO postgres;
