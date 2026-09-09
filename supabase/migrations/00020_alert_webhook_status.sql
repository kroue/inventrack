-- =============================================================================
-- 00020 — Diagnostic: is the notification service wired up?
--
-- notify_alert_webhook() deliberately returns early when private.app_settings
-- has no URL or key, so a misconfigured install records alerts silently and
-- sends nothing. That failure mode is invisible from the application, and
-- app_settings is (correctly) unreadable by the anon and authenticated roles.
--
-- This reports whether each value is present. It returns the function URL, which
-- is not a secret, and never the key itself — only whether one is set.
-- =============================================================================

CREATE OR REPLACE FUNCTION alert_webhook_status()
RETURNS JSONB AS $$
DECLARE
    v_url TEXT;
    v_key TEXT;
BEGIN
    PERFORM assert_admin_or_service('inspect the notification settings');

    SELECT value INTO v_url FROM private.app_settings WHERE key = 'alert_function_url';
    SELECT value INTO v_key FROM private.app_settings WHERE key = 'alert_function_key';

    RETURN jsonb_build_object(
        'configured',     (v_url IS NOT NULL AND v_key IS NOT NULL),
        'url_configured', v_url IS NOT NULL,
        'key_configured', v_key IS NOT NULL,
        'key_length',     COALESCE(length(v_key), 0),
        'function_url',   COALESCE(v_url, '(not set)'),
        'active_alerts',  (SELECT COUNT(*) FROM alerts WHERE status = 'Active')
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION alert_webhook_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_webhook_status() TO authenticated;
