-- =============================================================================
-- 00015 — Security hardening before public deployment
--
-- Closes four issues found auditing the app ahead of its first public deploy:
--
--   1. Cashiers could not read their own `users` row, so the client fell through
--      to an in-memory profile that guessed the role from the email address.
--   2. record_stock_adjustment and reconcile_batch_inventory are SECURITY
--      DEFINER — they bypass RLS — but were executable by any authenticated
--      user, letting a Cashier rewrite any product's stock.
--   3. product_price_history was readable and writable by every authenticated
--      user, exposing supplier cost prices (margins) to Cashiers.
--   4. users.password stored credentials in clear text.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Let a user read their own profile
--
-- Without this the only policy on `users` was admin_all, so a Cashier's own
-- lookup returned nothing and the client invented a role. Policies are OR'ed,
-- so admins keep full access through the existing policy.
--
-- Matching on email as well as user_id covers accounts whose public.users row
-- was never linked to their auth.users id. Rewriting that id is not an option:
-- user_id is the primary key and is referenced by sales, stock_log, deliveries
-- and product_price_history.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users read own profile" ON users;
CREATE POLICY "Users read own profile"
    ON users FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR lower(email) = lower(auth.jwt() ->> 'email')
    );

-- -----------------------------------------------------------------------------
-- 2. Restrict the RLS-bypassing maintenance functions to administrators
--
-- auth.uid() is NULL when a statement runs outside PostgREST — a migration, or
-- the dashboard SQL editor. Those contexts are already privileged, so they are
-- allowed through; every request arriving with a session must be an Admin.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_admin_or_service(p_action TEXT)
RETURNS VOID AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN; -- server-side invocation (migration / SQL editor)
    END IF;

    IF get_user_role() IS DISTINCT FROM 'Admin' THEN
        RAISE EXCEPTION 'Only an administrator may %.', p_action
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- record_stock_adjustment: same body as migration 00011 with the guard added.
CREATE OR REPLACE FUNCTION record_stock_adjustment(
    p_product_id  UUID,
    p_change_type change_type,
    p_quantity    INT,
    p_reason      TEXT
) RETURNS JSONB AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_product RECORD;
    v_batch RECORD;
    v_delta INT;
    v_magnitude INT;
    v_remaining INT;
    v_take INT;
    v_available INT;
    v_target_batch UUID;
    v_new_stock INT;
    v_reason TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: No active user session found.';
    END IF;

    PERFORM assert_admin_or_service('adjust stock');

    IF p_change_type NOT IN ('ADJUST', 'Customer Return', 'Return to Supplier') THEN
        RAISE EXCEPTION 'Unsupported adjustment category: %.', p_change_type;
    END IF;

    v_reason := NULLIF(TRIM(COALESCE(p_reason, '')), '');
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'A reason is required for every stock adjustment.';
    END IF;

    SELECT * INTO v_product FROM products WHERE product_id = p_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Product % does not exist.', p_product_id;
    END IF;

    IF p_change_type = 'Customer Return' THEN
        IF p_quantity <= 0 THEN
            RAISE EXCEPTION 'A customer return must be a positive quantity.';
        END IF;
        v_delta := p_quantity;
    ELSIF p_change_type = 'Return to Supplier' THEN
        IF p_quantity <= 0 THEN
            RAISE EXCEPTION 'A return to supplier must be a positive quantity.';
        END IF;
        v_delta := -p_quantity;
    ELSE
        IF p_quantity = 0 THEN
            RAISE EXCEPTION 'An adjustment of zero changes nothing.';
        END IF;
        v_delta := p_quantity;
    END IF;

    v_magnitude := ABS(v_delta);

    IF v_delta < 0 THEN
        SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_available
        FROM batches
        WHERE product_id = p_product_id AND quantity_remaining > 0;

        IF v_available < v_magnitude THEN
            RAISE EXCEPTION 'Only % unit(s) of % remain across its batches; cannot remove %. If the inventory total disagrees with this figure, run SELECT reconcile_batch_inventory(); to realign them.',
                v_available, v_product.product_name, v_magnitude;
        END IF;

        v_remaining := v_magnitude;

        FOR v_batch IN
            SELECT * FROM batches
            WHERE product_id = p_product_id AND quantity_remaining > 0
            ORDER BY batch_expiration ASC
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            v_take := LEAST(v_batch.quantity_remaining, v_remaining);

            UPDATE batches
            SET quantity_remaining = quantity_remaining - v_take
            WHERE batch_id = v_batch.batch_id;

            INSERT INTO stock_log (product_id, batch_id, user_id, quantity, change_type, remarks)
            VALUES (p_product_id, v_batch.batch_id, v_user_id, v_take, p_change_type, v_reason);

            v_remaining := v_remaining - v_take;
        END LOOP;
    ELSE
        SELECT batch_id INTO v_target_batch
        FROM batches
        WHERE product_id = p_product_id AND quantity_remaining > 0
        ORDER BY batch_expiration DESC
        LIMIT 1
        FOR UPDATE;

        IF v_target_batch IS NULL THEN
            INSERT INTO batches (product_id, quantity_received, quantity_remaining, batch_expiration, risk_score)
            VALUES (p_product_id, v_magnitude, v_magnitude, NOW() + INTERVAL '365 days', 'Normal')
            RETURNING batch_id INTO v_target_batch;
        ELSE
            UPDATE batches
            SET quantity_remaining = quantity_remaining + v_magnitude,
                quantity_received  = quantity_received + v_magnitude
            WHERE batch_id = v_target_batch;
        END IF;

        INSERT INTO stock_log (product_id, batch_id, user_id, quantity, change_type, remarks)
        VALUES (p_product_id, v_target_batch, v_user_id, v_magnitude, p_change_type, v_reason);
    END IF;

    UPDATE inventory
    SET stock_quantity = GREATEST(0, stock_quantity + v_delta)
    WHERE product_id = p_product_id
    RETURNING stock_quantity INTO v_new_stock;

    IF v_new_stock IS NULL THEN
        INSERT INTO inventory (product_id, stock_quantity, safety_stock, lead_time, reorder_point)
        VALUES (p_product_id, GREATEST(0, v_delta), 0, 1, 0)
        RETURNING stock_quantity INTO v_new_stock;
    END IF;

    RETURN jsonb_build_object(
        'product_id',    p_product_id,
        'change_type',   p_change_type,
        'quantity',      v_magnitude,
        'direction',     CASE WHEN v_delta > 0 THEN 'IN' ELSE 'OUT' END,
        'stock_quantity', v_new_stock
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- reconcile_batch_inventory: guard only; the body is unchanged from 00012.
CREATE OR REPLACE FUNCTION reconcile_batch_inventory()
RETURNS JSONB AS $$
DECLARE
    v_row RECORD;
    v_batch RECORD;
    v_diff INT;
    v_remaining INT;
    v_take INT;
    v_target_batch UUID;
    v_scanned INT := 0;
    v_corrected INT := 0;
    v_units_added INT := 0;
    v_units_removed INT := 0;
BEGIN
    PERFORM assert_admin_or_service('reconcile stock');

    INSERT INTO inventory (product_id, stock_quantity, safety_stock, lead_time, reorder_point)
    SELECT b.product_id, SUM(b.quantity_remaining), 0, 1, 0
    FROM batches b
    WHERE b.quantity_remaining > 0
      AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = b.product_id)
    GROUP BY b.product_id;

    FOR v_row IN
        SELECT
            i.product_id,
            i.stock_quantity,
            COALESCE((
                SELECT SUM(b.quantity_remaining)
                FROM batches b
                WHERE b.product_id = i.product_id AND b.quantity_remaining > 0
            ), 0) AS batch_total
        FROM inventory i
    LOOP
        v_scanned := v_scanned + 1;
        v_diff := v_row.stock_quantity - v_row.batch_total;

        CONTINUE WHEN v_diff = 0;

        IF v_diff > 0 THEN
            SELECT batch_id INTO v_target_batch
            FROM batches
            WHERE product_id = v_row.product_id AND quantity_remaining > 0
            ORDER BY batch_expiration DESC
            LIMIT 1
            FOR UPDATE;

            IF v_target_batch IS NULL THEN
                INSERT INTO batches (product_id, quantity_received, quantity_remaining, batch_expiration, risk_score)
                VALUES (v_row.product_id, v_diff, v_diff, NOW() + INTERVAL '365 days', 'Normal')
                RETURNING batch_id INTO v_target_batch;
            ELSE
                UPDATE batches
                SET quantity_remaining = quantity_remaining + v_diff,
                    quantity_received  = quantity_received + v_diff
                WHERE batch_id = v_target_batch;
            END IF;

            INSERT INTO stock_log (product_id, batch_id, user_id, quantity, change_type, remarks)
            VALUES (v_row.product_id, v_target_batch, NULL, v_diff, 'ADJUST',
                    'System reconciliation: batch pool was short by ' || v_diff ||
                    ' unit(s) against the recorded inventory total.');

            v_units_added := v_units_added + v_diff;
        ELSE
            v_remaining := -v_diff;

            FOR v_batch IN
                SELECT * FROM batches
                WHERE product_id = v_row.product_id AND quantity_remaining > 0
                ORDER BY batch_expiration ASC
                FOR UPDATE
            LOOP
                EXIT WHEN v_remaining <= 0;

                v_take := LEAST(v_batch.quantity_remaining, v_remaining);

                UPDATE batches
                SET quantity_remaining = quantity_remaining - v_take
                WHERE batch_id = v_batch.batch_id;

                INSERT INTO stock_log (product_id, batch_id, user_id, quantity, change_type, remarks)
                VALUES (v_row.product_id, v_batch.batch_id, NULL, v_take, 'ADJUST',
                        'System reconciliation: batch pool exceeded the recorded inventory total.');

                v_remaining := v_remaining - v_take;
            END LOOP;

            v_units_removed := v_units_removed + (-v_diff);
        END IF;

        v_corrected := v_corrected + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'products_scanned',   v_scanned,
        'products_corrected', v_corrected,
        'units_added',        v_units_added,
        'units_removed',      v_units_removed
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -----------------------------------------------------------------------------
-- 3. Price history is management data — supplier cost reveals the margin
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Enable all operations for authenticated users" ON product_price_history;

DROP POLICY IF EXISTS "Admin Full Access - product_price_history" ON product_price_history;
CREATE POLICY "Admin Full Access - product_price_history"
    ON product_price_history FOR ALL TO authenticated
    USING (get_user_role() = 'Admin')
    WITH CHECK (get_user_role() = 'Admin');

-- -----------------------------------------------------------------------------
-- 4. Remove the clear-text password column
--
-- Authentication runs entirely through Supabase Auth; this column was never
-- consulted at login. It only ever held a plaintext copy of a credential the
-- user very likely reuses elsewhere.
-- -----------------------------------------------------------------------------

ALTER TABLE users DROP COLUMN IF EXISTS password;
