export const preparedActivityMigration = `
  ALTER TABLE activities ADD COLUMN initial_prepared_practice_version INTEGER CHECK (initial_prepared_practice_version > 0);
  ALTER TABLE activities ADD COLUMN initial_prepared_step_attempt_id TEXT
    CHECK ((initial_prepared_practice_version IS NULL) = (initial_prepared_step_attempt_id IS NULL));

  CREATE TABLE prepared_activity_version_changes (
    activity_id TEXT NOT NULL REFERENCES activities (id),
    operation_id TEXT NOT NULL,
    from_step_attempt_id TEXT NOT NULL,
    from_practice_version INTEGER NOT NULL CHECK (from_practice_version > 0),
    step_attempt_id TEXT NOT NULL,
    practice_version INTEGER NOT NULL CHECK (practice_version > 0),
    PRIMARY KEY (activity_id, operation_id)
  ) STRICT;
`;

export const preparedActivityIntentMigration = `
  ALTER TABLE prepared_activity_version_changes ADD COLUMN intent TEXT CHECK (intent = 'questionDeliveryMode');
`;
