\set ON_ERROR_STOP 1

BEGIN;

ALTER TABLE area DROP COLUMN sort_name;

COMMIT;
