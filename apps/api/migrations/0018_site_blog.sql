-- 0018 Public blog at APP_ORIGIN/blog, fed by Content Studio (ADR 0020). Additive only.
--
-- Only approved articles of the site's own organisation (vars.SITE_BLOG_ORG_ID) can be published, by a
-- person with content:approve. The post is a SNAPSHOT of the approved version: later edits in Content
-- Studio never change the public page until someone republishes it.

CREATE TABLE site_blog_posts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_item_id TEXT NOT NULL UNIQUE,
  content_version INTEGER NOT NULL,
  slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 3 AND 80),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'unpublished')),
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_site_blog_posts_public ON site_blog_posts (status, published_at DESC);
