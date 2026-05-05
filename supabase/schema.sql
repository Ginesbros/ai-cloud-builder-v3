create extension if not exists "uuid-ossp";

create table if not exists projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  goal text not null,
  status text not null default 'planning',
  repo_name text,
  repo_url text,
  vercel_url text,
  autonomy_mode text not null default 'dev',
  plan jsonb,
  memory jsonb not null default '{}'::jsonb,
  current_stage text,
  monthly_budget_usd numeric default 400,
  estimated_spend_usd numeric not null default 0,
  last_worker_heartbeat timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  title text not null,
  description text not null,
  type text not null default 'development',
  status text not null default 'pending',
  priority int not null default 100,
  attempts int not null default 0,
  assigned_worker_id text,
  locked_until timestamptz,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_files (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  path text not null,
  content text not null,
  sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, path)
);

create table if not exists logs (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  level text not null default 'info',
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);

create table if not exists ai_usage (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  role text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  estimated_cost_usd numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists sandbox_runs (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  command text not null,
  status text not null default 'queued',
  stdout text,
  stderr text,
  exit_code int,
  duration_ms int,
  created_at timestamptz not null default now()
);

create table if not exists approvals (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists budget_events (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  level text not null,
  message text not null,
  estimated_monthly_spend_usd numeric,
  budget_usd numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_tasks_project_status on tasks(project_id, status, priority);
create index if not exists idx_tasks_worker_lock on tasks(assigned_worker_id, locked_until);
create index if not exists idx_tasks_status_lock on tasks(status, locked_until);
create index if not exists idx_logs_project_created on logs(project_id, created_at desc);
create index if not exists idx_ai_usage_created on ai_usage(created_at desc);

-- Useful reset query during testing:
-- update tasks set status = 'pending', assigned_worker_id = null, locked_until = null, attempts = 0;
