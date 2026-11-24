export const activityRestartMigration = `
  CREATE TABLE activity_restarts (
    activity_id TEXT PRIMARY KEY REFERENCES activities (id),
    source_activity_id TEXT NOT NULL UNIQUE REFERENCES activities (id),
    source_status TEXT NOT NULL CHECK (source_status IN ('abandoned', 'completed')),
    restarted_at TEXT NOT NULL,
    CHECK (activity_id <> source_activity_id)
  ) STRICT;
`;
