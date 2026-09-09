-- =============================================================================
-- 00019 — Remove the trigger that granted Admin to every new account
--
-- A trigger on auth.users was silently provisioning a staff record for every
-- newly created login, hardcoded to the Admin role:
--
--   CREATE FUNCTION public.handle_new_user() ... SECURITY DEFINER AS $$
--   BEGIN
--     INSERT INTO public.users (user_id, full_name, email, role)
--     VALUES (new.id, new.email, new.email, 'Admin')
--     ON CONFLICT (user_id) DO NOTHING;
--     RETURN new;
--   END; $$;
--
-- This is a privilege escalation, not a cosmetic default. get_user_role() reads
-- exactly this row, so the account gained real Admin access under RLS — every
-- sale, every user record, supplier cost prices, and the RLS-bypassing stock
-- adjustment functions. With email signup enabled it was self-service.
--
-- It also broke legitimate provisioning: the trigger won the race against the
-- manage-staff function's own insert, so creating a cashier failed with a
-- duplicate users_pkey violation.
--
-- Provisioning is explicit now and does not need a trigger:
--   * Cashiers  — the manage-staff Edge Function creates login and record.
--   * Admins    — created in the Supabase dashboard, then linked with
--                 create_staff_profile(), which sets the role deliberately.
--
-- An account with no staff record now fails closed at sign-in with a clear
-- message, which is the correct outcome for an unprovisioned login.
-- =============================================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Clean up records the trigger created.
--
-- Its signature is full_name = email combined with the Admin role; a genuinely
-- provisioned admin has a real name. Rows matching that signature AND holding no
-- transaction history are demoted to Cashier rather than deleted, so nothing is
-- silently removed — an administrator can then delete or promote them knowingly.
--
-- Anything with recorded activity is left untouched and must be reviewed by hand.
-- -----------------------------------------------------------------------------

UPDATE public.users u
SET role = 'Cashier'
WHERE u.role = 'Admin'
  AND lower(u.full_name) = lower(u.email)
  AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.user_id = u.user_id)
  AND NOT EXISTS (SELECT 1 FROM stock_log l WHERE l.user_id = u.user_id)
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.received_by = u.user_id)
  AND NOT EXISTS (SELECT 1 FROM product_price_history h WHERE h.changed_by = u.user_id);
