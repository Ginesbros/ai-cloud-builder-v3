-- Self-improvement ideas inbox + run history

create table if not exists improvement_ideas (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  source text not null default 'user',           -- 'user' | 'auto_log' | 'auto_failure'
  status text not null default 'queued',         -- queued | planning | building | reviewing | pr_open | merged | failed | skipped | rejected
  scope text default 'small',                    -- small | feature | bigfeature | bugfix | unknown
  branch_name text,
  pr_url text,
  pr_number int,
  merge_commit_sha text,
  reverted_at timestamptz,
  estimated_cost_usd numeric default 0,
  actual_cost_usd numeric default 0,
  cost_cap_usd numeric default 5,
  forbidden_violation text,                      -- non-null = blocked because it tried to modify a forbidden file
  error text,
  result jsonb,                                  -- summary of what was done
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_improvement_ideas_status_created on improvement_ideas(status, created_at desc);
create index if not exists idx_improvement_ideas_source on improvement_ideas(source);

-- Self-improvement runs daily quota tracking
create table if not exists self_improvement_quota (
  day date primary key,
  prs_opened int default 0,
  ideas_processed int default 0,
  total_cost_usd numeric default 0
);
