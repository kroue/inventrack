-- =============================================================================
-- 00021 — Probe the alert webhook without sending an email
--
-- notify_alert_webhook() swallows failures on purpose: a notification must never
-- roll back the sale that raised it. The cost is that a bad key looks identical
-- to a working one from inside the app — the alert records either way and no
-- mail arrives.
--
-- This posts to the Edge Function using the stored credentials but with a
-- deliberately malformed body. send-alert-email validates the payload before it
-- calls Resend, so the round trip proves the URL and key without sending
-- anything:
--
--   401 -> the stored key is not accepted (gateway rejected it)
--   400 -> authenticated fine, then rejected the payload as intended  ✅
--   200 -> unexpected here; would mean an email was sent
--
-- pg_net is asynchronous, so probe first and read the reply a moment later.
-- =============================================================================

CREATE OR REPLACE FUNCTION probe_alert_webhook()
RETURNS JSONB AS $$
DECLARE
    v_url TEXT;
    v_key TEXT;
    v_request_id BIGINT;
BEGIN
    PERFORM assert_admin_or_service('test the notification service');

    SELECT value INTO v_url FROM private.app_settings WHERE key = 'alert_function_url';
    SELECT value INTO v_key FROM private.app_settings WHERE key = 'alert_function_key';

    IF v_url IS NULL OR v_key IS NULL THEN
        RAISE EXCEPTION 'The notification service is not configured.';
    END IF;

    SELECT net.http_post(
        url     := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key),
        -- No product_name / alert_type: the function rejects this before Resend.
        body    := jsonb_build_object('probe', true)
    ) INTO v_request_id;

    RETURN jsonb_build_object('request_id', v_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION read_webhook_probe(p_request_id BIGINT)
RETURNS JSONB AS $$
DECLARE
    v_status INT;
    v_content TEXT;
    v_error TEXT;
BEGIN
    PERFORM assert_admin_or_service('read the notification test result');

    SELECT status_code, content INTO v_status, v_content
    FROM net._http_response WHERE id = p_request_id;

    IF v_status IS NULL THEN
        SELECT error_msg INTO v_error FROM net._http_response WHERE id = p_request_id;
        RETURN jsonb_build_object('pending_or_failed', true, 'error', v_error);
    END IF;

    RETURN jsonb_build_object(
        'status_code', v_status,
        'body', LEFT(COALESCE(v_content, ''), 300),
        'verdict', CASE
            WHEN v_status = 401 THEN 'REJECTED — the stored key is not accepted'
            WHEN v_status = 400 THEN 'OK — authenticated, payload rejected as designed (no email sent)'
            WHEN v_status = 500 THEN 'Authenticated, but the function errored — check RESEND_API_KEY / ALERT_RECIPIENT'
            ELSE 'Unexpected status'
        END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION probe_alert_webhook() FROM PUBLIC;
REVOKE ALL ON FUNCTION read_webhook_probe(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION probe_alert_webhook() TO authenticated;
GRANT EXECUTE ON FUNCTION read_webhook_probe(BIGINT) TO authenticated;
