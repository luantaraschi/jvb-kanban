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
  kind TEXT NOT NULL CHECK (kind IN ('feedback', 'assignment', 'initial_triage', 'chat', 'report_snapshot', 'pdf_intake', 'pdf_analysis')),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_report_snapshots (
  id BIGSERIAL PRIMARY KEY,
  period TEXT NOT NULL CHECK (period IN ('today', '7d', '30d', 'history')),
  source TEXT NOT NULL DEFAULT 'manual',
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  report_json JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_performance_profiles (
  id BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_name TEXT NOT NULL,
  category TEXT NOT NULL,
  category_label TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 1,
  confidence INTEGER NOT NULL DEFAULT 1,
  sample_size INTEGER NOT NULL DEFAULT 0,
  done_count INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  doing_count INTEGER NOT NULL DEFAULT 0,
  avg_done_ms BIGINT NOT NULL DEFAULT 0,
  review_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
  protocol_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
  keyword_hits INTEGER NOT NULL DEFAULT 0,
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot_id BIGINT REFERENCES ai_report_snapshots(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, category)
);

CREATE TABLE IF NOT EXISTS ai_pending_documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_bucket TEXT,
  storage_path TEXT,
  storage_status TEXT NOT NULL DEFAULT 'not_configured',
  extracted_text TEXT NOT NULL DEFAULT '',
  analysis_json JSONB,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'analyzed', 'applied', 'failed')),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  analyzed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_pending_document_suggestions (
  id BIGSERIAL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES ai_pending_documents(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assigned_to_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'administrativo',
  priority TEXT NOT NULL DEFAULT 'media',
  reason TEXT NOT NULL DEFAULT '',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, is_active);
CREATE INDEX IF NOT EXISTS idx_task_activity_task_id ON task_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_task_activity_created_at ON task_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_kind_created_at ON ai_runs(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_report_snapshots_period_generated_at ON ai_report_snapshots(period, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_performance_profiles_employee ON ai_performance_profiles(employee_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_ai_pending_documents_created_at ON ai_pending_documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_pending_document_suggestions_document ON ai_pending_document_suggestions(document_id, sort_order ASC);
