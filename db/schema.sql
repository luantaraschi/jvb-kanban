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

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, is_active);
