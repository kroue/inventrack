-- =============================================================================
-- 00018 — Introspection helper for triggers on auth.users
--
-- Creating a login through the manage-staff function produced a public.users row
-- with role 'Admin' and the email as the display name — values neither the
-- function nor the application writes. That points at a trigger on auth.users
-- populating public.users behind the app's back, which needs identifying before
-- it can be corrected.
--
-- Admin-only, read-only, and safe to leave in place as a diagnostic.
-- =============================================================================

CREATE OR REPLACE FUNCTION list_auth_user_triggers()
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    PERFORM assert_admin_or_service('inspect database triggers');

    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_result
    FROM (
        SELECT
            tg.tgname                              AS trigger_name,
            NOT tg.tgisinternal                    AS user_defined,
            p.proname                              AS function_name,
            n.nspname                              AS function_schema,
            pg_get_functiondef(p.oid)              AS definition
        FROM pg_trigger tg
        JOIN pg_class c   ON c.oid = tg.tgrelid
        JOIN pg_namespace cn ON cn.oid = c.relnamespace
        JOIN pg_proc p    ON p.oid = tg.tgfoid
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE cn.nspname = 'auth'
          AND c.relname = 'users'
          AND NOT tg.tgisinternal
    ) t;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION list_auth_user_triggers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_auth_user_triggers() TO authenticated;
