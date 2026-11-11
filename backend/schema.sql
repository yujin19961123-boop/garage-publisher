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

ALTER TABLE releases ADD COLUMN IF NOT EXISTS version_number integer;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS cleaned_at timestamptz;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS manifest_ready boolean NOT NULL DEFAULT false;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS files_cleaned_at timestamptz;
WITH numbered AS (
 SELECT r.id, COALESCE((SELECT max(old.version_number) FROM releases old WHERE old.project_id=r.project_id),0)
 + row_number() OVER (PARTITION BY r.project_id ORDER BY r.created_at,r.id) AS number
 FROM releases r WHERE r.version_number IS NULL
) UPDATE releases r SET version_number=n.number FROM numbered n WHERE r.id=n.id;
ALTER TABLE releases ALTER COLUMN version_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS release_project_version ON releases(project_id,version_number);
CREATE INDEX IF NOT EXISTS retained_release_lookup ON releases(project_id,version_number DESC) WHERE expired_at IS NULL;
CREATE INDEX IF NOT EXISTS deployment_history_order ON deployments(project_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS failed_deployment_cleanup ON deployments(project_id,id) WHERE status='FAILED' AND files_cleaned_at IS NULL;
CREATE TABLE IF NOT EXISTS version_cleanup_jobs(
 deployment_id text PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 attempts integer NOT NULL DEFAULT 0, last_error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS version_cleanup_project ON version_cleanup_jobs(project_id);

-- Earlier releases did not retain a complete login history. Start a durable,
-- explicit baseline rather than guessing from surviving/expired sessions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_stats_since timestamptz NOT NULL DEFAULT now();
ALTER TABLE project_cleanup_jobs ADD COLUMN IF NOT EXISTS owner_id text REFERENCES users(id);
UPDATE project_cleanup_jobs j SET owner_id=(
 SELECT a.actor_id FROM audit_logs a JOIN users u ON u.id=a.actor_id
 WHERE a.action='delete_project' AND a.target_id=j.project_id ORDER BY a.id DESC LIMIT 1
) WHERE j.owner_id IS NULL;
