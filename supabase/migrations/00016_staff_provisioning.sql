-- =============================================================================
-- 00016 — Staff account provisioning
--
-- public.users.user_id defaults to gen_random_uuid(), and the Add Cashier form
-- inserted a row without setting it. The resulting profile therefore carried a
-- random id that could never match the account's auth.users.id.
--
-- The damage is quiet rather than loud: the user can still sign in, because the
-- policy added in 00015 also matches on email, but get_user_role() looks up
-- strictly by user_id and returns NULL. Every RLS policy then evaluates false
-- and the cashier lands on an empty POS with no error to explain it.
--
-- This migration:
--   1. relinks existing profiles to their auth.users id where it is safe, and
--   2. replaces the blind INSERT with an RPC that derives user_id from
--      auth.users so a mismatched profile can no longer be created.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Repair existing mismatched profiles
--
-- user_id is the primary key and four tables reference it, all with the default
-- NO ACTION on update — so a relink is only possible while nothing points at the
-- old id. In practice that is exactly the set of rows that need repairing: a
-- mismatched profile cannot have sales, because process_pos_sale writes
-- sales.user_id = auth.uid(), which would violate the same foreign key. Rows
-- that cannot be relinked are reported rather than forced.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION relink_staff_profiles()
RETURNS JSONB AS $$
DECLARE
    v_row RECORD;
    v_relinked INT := 0;
    v_blocked TEXT[] := ARRAY[]::TEXT[];
    v_refs INT;
BEGIN
    PERFORM assert_admin_or_service('relink staff profiles');

    FOR v_row IN
        SELECT u.user_id AS old_id, a.id AS auth_id, u.email
        FROM public.users u
        JOIN auth.users a ON lower(a.email) = lower(u.email)
        WHERE u.user_id IS DISTINCT FROM a.id
    LOOP
        -- Never collide with a profile that already holds the target id.
        IF EXISTS (SELECT 1 FROM public.users WHERE user_id = v_row.auth_id) THEN
            v_blocked := v_blocked || (v_row.email || ' (another profile already uses that login)');
            CONTINUE;
        END IF;

        SELECT
            (SELECT COUNT(*) FROM sales WHERE user_id = v_row.old_id)
          + (SELECT COUNT(*) FROM stock_log WHERE user_id = v_row.old_id)
          + (SELECT COUNT(*) FROM deliveries WHERE received_by = v_row.old_id)
          + (SELECT COUNT(*) FROM product_price_history WHERE changed_by = v_row.old_id)
        INTO v_refs;

        IF v_refs > 0 THEN
            v_blocked := v_blocked || (v_row.email || ' (' || v_refs || ' existing record(s) reference the old id)');
            CONTINUE;
        END IF;

        UPDATE public.users SET user_id = v_row.auth_id WHERE user_id = v_row.old_id;
        v_relinked := v_relinked + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'relinked', v_relinked,
        'blocked',  to_jsonb(v_blocked)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION relink_staff_profiles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relink_staff_profiles() TO authenticated;

SELECT relink_staff_profiles();

-- -----------------------------------------------------------------------------
-- 2. Create a staff profile against a login that actually exists
--
-- Refuses when there is no matching auth.users row, rather than leaving an
-- orphan profile behind. Sign-in itself stays delegated to Supabase Auth, so no
-- password ever passes through here.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_staff_profile(
    p_email     TEXT,
    p_full_name TEXT,
    p_role      role_type DEFAULT 'Cashier'
) RETURNS JSONB AS $$
DECLARE
    v_email TEXT;
    v_name TEXT;
    v_auth_id UUID;
    v_existing RECORD;
BEGIN
    PERFORM assert_admin_or_service('create staff accounts');

    v_email := lower(NULLIF(TRIM(COALESCE(p_email, '')), ''));
    v_name  := NULLIF(TRIM(COALESCE(p_full_name, '')), '');

    IF v_email IS NULL THEN
        RAISE EXCEPTION 'An email address is required.';
    END IF;

    IF v_name IS NULL THEN
        RAISE EXCEPTION 'A full name is required.';
    END IF;

    SELECT id INTO v_auth_id FROM auth.users WHERE lower(email) = v_email;

    IF v_auth_id IS NULL THEN
        RAISE EXCEPTION 'No login exists for %. Create the user under Authentication in the Supabase dashboard first, then add them here.', v_email;
    END IF;

    -- Already provisioned against this login.
    SELECT * INTO v_existing FROM public.users WHERE user_id = v_auth_id;
    IF FOUND THEN
        RAISE EXCEPTION 'A staff record for % already exists.', v_email;
    END IF;

    -- An orphaned profile from the old flow: adopt it and fix its id.
    SELECT * INTO v_existing FROM public.users WHERE lower(email) = v_email;
    IF FOUND THEN
        UPDATE public.users
        SET user_id   = v_auth_id,
            full_name = v_name,
            role      = p_role,
            is_active = TRUE
        WHERE user_id = v_existing.user_id;

        RETURN jsonb_build_object('user_id', v_auth_id, 'email', v_email, 'role', p_role, 'repaired', TRUE);
    END IF;

    INSERT INTO public.users (user_id, email, full_name, role, is_active)
    VALUES (v_auth_id, v_email, v_name, p_role, TRUE);

    RETURN jsonb_build_object('user_id', v_auth_id, 'email', v_email, 'role', p_role, 'repaired', FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION create_staff_profile(TEXT, TEXT, role_type) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_staff_profile(TEXT, TEXT, role_type) TO authenticated;
