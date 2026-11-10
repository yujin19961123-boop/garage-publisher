CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL, role text NOT NULL DEFAULT 'member', status text NOT NULL DEFAULT 'active', auth_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(token text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), auth_version integer NOT NULL, csrf text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id text PRIMARY KEY, public_id text UNIQUE NOT NULL, owner_id text NOT NULL REFERENCES users(id), name text NOT NULL, current_release_id text, last_published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS deployments(id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), operator_id text NOT NULL REFERENCES users(id), status text NOT NULL, route_mode text NOT NULL, error_message text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS project_active_deployment ON deployments(project_id) WHERE status IN ('UPLOADING','QUEUED','VALIDATING','PREPARING');
CREATE TABLE IF NOT EXISTS releases(id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), deployment_id text UNIQUE NOT NULL REFERENCES deployments(id), route_mode text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs(id bigserial PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, target_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS share_pages(owner_id text PRIMARY KEY REFERENCES users(id), public_id text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE projects DROP COLUMN IF EXISTS description;
CREATE TABLE IF NOT EXISTS deleted_project_slugs(public_id text PRIMARY KEY, deleted_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS project_cleanup_jobs(project_id text PRIMARY KEY, deployment_ids text[] NOT NULL, attempts integer NOT NULL DEFAULT 0, last_error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
