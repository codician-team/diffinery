-- The IndexNow endpoint that answered a submission (web/indexnow.ts tries the next one when an endpoint
-- rate-limits the Worker's shared outbound addresses or can't be reached).
ALTER TABLE indexnow_submissions ADD COLUMN endpoint TEXT;
