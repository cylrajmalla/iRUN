-- =============================================================================
-- Housekeeping: territory that has been gray/neutral for a long time (nobody
-- has bothered to recapture it) is safe to hard-delete to keep the GIST index
-- and table size bounded. This is NOT what makes territory "expire" visually
-- — that's the expires_at < now() check in territory_lines_with_status.
-- This just garbage-collects rows that are neutral AND stale.
--
-- Run this on a schedule (see src/jobs/expiryCleanupJob.ts), e.g. hourly.
-- =============================================================================
CREATE OR REPLACE FUNCTION purge_stale_neutral_territory(stale_after_days INT DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM territory_lines
    WHERE expires_at < now() - (stale_after_days || ' days')::interval;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
