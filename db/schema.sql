CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  color TEXT NOT NULL DEFAULT '#2d7be5',
  pastel TEXT NOT NULL DEFAULT '#e8f0fc',
  col_bg TEXT NOT NULL DEFAULT '#f4f8fe',
  board_bg TEXT NOT NULL DEFAULT '#eef4fd',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  assigned_by TEXT NOT NULL DEFAULT '',
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id BIGINT REFERENCES users(id),
  updated_by_user_id BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  elapsed BIGINT NOT NULL DEFAULT 0,
  timer_start BIGINT,
  completed_at TEXT,
  needs_revisao BOOLEAN NOT NULL DEFAULT FALSE,
  needs_protocolo BOOLEAN NOT NULL DEFAULT FALSE,
  flag_agendei BOOLEAN NOT NULL DEFAULT FALSE,
  flag_dispensa BOOLEAN NOT NULL DEFAULT FALSE,
  flag_protreal BOOLEAN NOT NULL DEFAULT FALSE,
  flag_naoaplic BOOLEAN NOT NULL DEFAULT FALSE,
  last_edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS history_snapshots (
  id BIGSERIAL PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  closed_at TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_activity (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'status_change', 'reassign', 'delete')),
  actor_user_id BIGINT REFERENCES users(id),
  target_user_id BIGINT REFERENCES users(id),
  before_json JSONB,
  after_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('feedback', 'assignment', 'initial_triage', 'chat')),
  created_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, is_active);
CREATE INDEX IF NOT EXISTS idx_task_activity_task_id ON task_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_task_activity_created_at ON task_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_kind_created_at ON ai_runs(kind, created_at DESC);
