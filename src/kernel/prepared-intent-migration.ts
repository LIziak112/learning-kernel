export const preparedIntentCheckMigration = `
  CREATE TABLE prepared_activity_version_changes_replacement (
    activity_id TEXT NOT NULL REFERENCES activities (id),
    operation_id TEXT NOT NULL,
    from_step_attempt_id TEXT NOT NULL,
    from_practice_version INTEGER NOT NULL CHECK (from_practice_version > 0),
    step_attempt_id TEXT NOT NULL,
    practice_version INTEGER NOT NULL CHECK (practice_version > 0),
    intent TEXT CHECK (intent IS NULL OR length(intent) > 0),
    PRIMARY KEY (activity_id, operation_id)
  ) STRICT;
  INSERT INTO prepared_activity_version_changes_replacement SELECT
    activity_id, operation_id, from_step_attempt_id, from_practice_version, step_attempt_id, practice_version, intent
    FROM prepared_activity_version_changes;
  DROP TABLE prepared_activity_version_changes;
  ALTER TABLE prepared_activity_version_changes_replacement RENAME TO prepared_activity_version_changes;
`;
