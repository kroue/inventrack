-- =============================================================================
-- 00012 — Reconcile the batch pool against the inventory totals
--
-- Before migration 00011, returns and adjustments moved `inventory.stock_quantity`
-- without touching `batches`. Every other path (POS sales, deliveries) kept both
-- in step, which makes `inventory.stock_quantity` the more complete record and
-- the batch pool the one carrying the drift.
--
-- That drift matters now: record_stock_adjustment and import_offline_sales both
-- refuse to deplete more units than the batch pool actually holds. Left alone,
-- the first Return to Supplier on a drifted product would fail with a shortfall
-- message even though the inventory total says the stock is there.
--
-- This migration closes the gap once, and leaves the routine in place so it can
-- be re-run at any time. It is idempotent: a second run corrects nothing.
--
-- Direction of the correction, per product:
--   inventory > batch pool  -> the batches under-count; top the newest batch up
--   inventory < batch pool  -> the batches over-count; deplete FEFO
--
-- Every correction writes an ADJUST row to stock_log, so a reconciliation is
-- never a silent change to stock.
-- =============================================================================

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
    -- Products that hold batches but never got an inventory row: create one that
    -- matches the batch pool rather than leaving the product unrepresented.
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
            -- Batches under-count. Return the missing units to the batch that
            -- expires last, so reconciled stock does not jump the FEFO queue
            -- ahead of genuinely older stock.
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
            -- Batches over-count. Deplete First Expired, First Out.
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

REVOKE ALL ON FUNCTION reconcile_batch_inventory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_batch_inventory() TO authenticated;

-- Close the existing gap as part of this migration.
SELECT reconcile_batch_inventory();
