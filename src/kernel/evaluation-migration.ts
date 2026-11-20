export const evaluationMigration = `
  ALTER TABLE performances RENAME TO single_performances;
  CREATE TABLE performances (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions (id),
    target_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    UNIQUE (submission_id, target_id, unit_id)
  ) STRICT;
  INSERT INTO performances (id, submission_id, target_id, unit_id)
    SELECT id, submission_id, target_id, 'wholeSelection' FROM single_performances;
  DROP TABLE single_performances;

  CREATE TABLE evaluation_tasks (
    submission_id TEXT PRIMARY KEY REFERENCES submissions (id),
    key_id TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
    FOREIGN KEY (key_id, key_version) REFERENCES scoring_keys (id, version)
  ) STRICT;
  CREATE TABLE automatic_verdicts (
    submission_id TEXT NOT NULL REFERENCES evaluation_tasks (submission_id),
    target_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
    PRIMARY KEY (submission_id, target_id, question_id)
  ) STRICT;
  CREATE TABLE reading_reviews (
    activity_id TEXT PRIMARY KEY REFERENCES activities (id),
    reviewer_id TEXT NOT NULL,
    selection_feedback TEXT
  ) STRICT;
`;

export const teacherReviewTargetMigration = `
  CREATE TABLE assessment_targets_replacement (
    submission_id TEXT PRIMARY KEY REFERENCES submissions (id),
    key_id TEXT,
    key_version INTEGER,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
    CHECK ((key_id IS NULL) = (key_version IS NULL)),
    CHECK (key_id IS NOT NULL OR status = 'done'),
    FOREIGN KEY (key_id, key_version) REFERENCES scoring_keys (id, version)
  ) STRICT;
  INSERT INTO assessment_targets_replacement (submission_id, key_id, key_version, target_id, status)
    SELECT submission_id, key_id, key_version, target_id, status FROM evaluation_tasks;
  DROP TABLE evaluation_tasks;
  ALTER TABLE assessment_targets_replacement RENAME TO evaluation_tasks;
`;
