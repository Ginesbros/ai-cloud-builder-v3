-- Plan-first approval workflow + preview/publish columns

-- New project columns
alter table projects add column if not exists awaiting_approval boolean default false;
alter table projects add column if not exists approved_at timestamptz;
alter table projects add column if not exists plan_revision int default 1;
alter table projects add column if not exists refine_notes text;

-- Preview/publish state
alter table projects add column if not exists preview_url text;
alter table projects add column if not exists preview_expires_at timestamptz;
alter table projects add column if not exists production_url text;
alter table projects add column if not exists published_at timestamptz;

-- Helpful index for the dashboard
create index if not exists idx_projects_status_updated on projects(status, updated_at desc);
