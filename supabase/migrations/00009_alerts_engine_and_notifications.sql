-- =============================================================================
-- 00009 — Predictive alert persistence + Automated Notification Service
--
-- Implements the alerting half of the System Architecture: the database detects
-- a stock level crossing the Reorder Point, writes an alert row, and a webhook
-- fires a Supabase Edge Function that emails the Admin through Resend.
--
-- Division of responsibility:
--   * The forecasting engine (EMA velocity -> ROP -> SOQ) runs in
--     InventoryLogicService and persists to `forecasts` and
--     `inventory.reorder_point`.
--   * This migration only *compares against* the stored reorder point, so the
--     EMA formula is not duplicated between TypeScript and PL/pgSQL.
--   * Running here (rather than in the client) means a Cashier completing a POS
--     sale still raises alerts, even though RLS forbids them writing `alerts`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Constraints the forecasting engine relies on
-- -----------------------------------------------------------------------------

-- InventoryLogicService upserts forecasts with onConflict: 'product_id'.
-- Without this constraint that upsert errors out.
DELETE FROM forecasts f
USING forecasts dup
WHERE f.product_id = dup.product_id
  AND f.forecast_id < dup.forecast_id;

ALTER TABLE forecasts DROP CONSTRAINT IF EXISTS forecasts_product_id_key;
ALTER TABLE forecasts ADD CONSTRAINT forecasts_product_id_key UNIQUE (product_id);

-- Only one Active alert per product per type, so a webhook fires once per
-- condition rather than once per sale. Existing duplicates are resolved first,
-- otherwise the index cannot be built.
UPDATE alerts a
SET status = 'Resolved'
WHERE a.status = 'Active'
  AND a.alert_id <> (
      SELECT b.alert_id FROM alerts b
      WHERE b.product_id = a.product_id
        AND b.alert_type = a.alert_type
        AND b.status = 'Active'
      ORDER BY b.triggered_date DESC, b.alert_id DESC
      LIMIT 1
  );

DROP INDEX IF EXISTS alerts_one_active_per_product_type;
CREATE UNIQUE INDEX alerts_one_active_per_product_type
    ON alerts (product_id, alert_type)
    WHERE status = 'Active';

-- Only one Pending restock request per product — same de-duplication first.
DELETE FROM restock_requests r
WHERE r.status = 'Pending'
  AND r.request_id <> (
      SELECT s.request_id FROM restock_requests s
      WHERE s.product_id = r.product_id
        AND s.status = 'Pending'
      ORDER BY s.request_date DESC, s.request_id DESC
      LIMIT 1
  );

DROP INDEX IF EXISTS restock_requests_one_pending_per_product;
CREATE UNIQUE INDEX restock_requests_one_pending_per_product
    ON restock_requests (product_id)
    WHERE status = 'Pending';

-- -----------------------------------------------------------------------------
-- 2. Configuration for the notification webhook
--
-- Kept out of the public schema and locked down so the anon/authenticated roles
-- can never read the service key. Populate it once per environment:
--
--   INSERT INTO private.app_settings (key, value) VALUES
--     ('alert_function_url', 'https://<project-ref>.functions.supabase.co/send-alert-email'),
--     ('alert_function_key', '<service-role-key>');
-- -----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

ALTER TABLE private.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.app_settings FROM anon, authenticated;

-- pg_net powers the outbound HTTP call from the trigger.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- -----------------------------------------------------------------------------
-- 3. Raise a LOW STOCK alert when stock crosses the Reorder Point
--    Alert condition:  A_i = 1 if Q_i <= ROP_i
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_reorder_point()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.stock_quantity <= NEW.reorder_point THEN
        -- ON CONFLICT against the partial unique index keeps this idempotent.
        INSERT INTO alerts (product_id, alert_type, status)
        VALUES (NEW.product_id, 'LOW STOCK', 'Active')
        ON CONFLICT DO NOTHING;
    ELSE
        -- Stock recovered (a delivery landed) — close the alert out so the next
        -- dip raises a fresh one and re-notifies.
        UPDATE alerts
        SET status = 'Resolved'
        WHERE product_id = NEW.product_id
          AND alert_type = 'LOW STOCK'
          AND status = 'Active';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_check_reorder_point ON inventory;
CREATE TRIGGER trg_check_reorder_point
    AFTER INSERT OR UPDATE OF stock_quantity, reorder_point ON inventory
    FOR EACH ROW EXECUTE FUNCTION check_reorder_point();

-- -----------------------------------------------------------------------------
-- 4. Webhook: every new Active alert calls the Edge Function
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION notify_alert_webhook()
RETURNS TRIGGER AS $$
DECLARE
    v_url TEXT;
    v_key TEXT;
    v_product RECORD;
BEGIN
    SELECT value INTO v_url FROM private.app_settings WHERE key = 'alert_function_url';
    SELECT value INTO v_key FROM private.app_settings WHERE key = 'alert_function_key';

    -- Not configured yet (e.g. local dev) — the alert is still recorded, it just
    -- does not send mail. Never fail the surrounding sale over a notification.
    IF v_url IS NULL OR v_key IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT p.product_name, i.stock_quantity, i.reorder_point
    INTO v_product
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.product_id
    WHERE p.product_id = NEW.product_id;

    PERFORM net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_key
        ),
        body    := jsonb_build_object(
            'alert_id',      NEW.alert_id,
            'alert_type',    NEW.alert_type,
            'product_id',    NEW.product_id,
            'product_name',  COALESCE(v_product.product_name, 'Unknown product'),
            'stock_quantity', COALESCE(v_product.stock_quantity, 0),
            'reorder_point', COALESCE(v_product.reorder_point, 0),
            'triggered_at',  NEW.triggered_date
        )
    );

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- A failed notification must never roll back the transaction that raised it.
    RAISE WARNING 'Alert webhook failed for alert %: %', NEW.alert_id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_alert_webhook ON alerts;
CREATE TRIGGER trg_notify_alert_webhook
    AFTER INSERT ON alerts
    FOR EACH ROW
    WHEN (NEW.status = 'Active')
    EXECUTE FUNCTION notify_alert_webhook();
