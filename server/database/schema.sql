-- ECHO schema, migration 1. All timestamps are epoch milliseconds (UTC instants);
-- calendar interpretation happens in the conversation's timezone at query time.

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  timezone    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  reply_to         TEXT REFERENCES messages(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'cancelled', 'error')),
  created_at       INTEGER NOT NULL,
  metadata         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);

-- Full-text index over message content (external-content FTS5, kept in sync by triggers).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  summary          TEXT NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id              TEXT PRIMARY KEY,
  canonical_name  TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  entity_type     TEXT NOT NULL DEFAULT 'other'
);

CREATE TABLE IF NOT EXISTS message_entities (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'mentioned' CHECK (relation IN ('mentioned', 'shortlisted', 'decided', 'researched')),
  PRIMARY KEY (message_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_message_entities_entity ON message_entities(entity_id);

-- Point-in-time observations of an attribute of an entity. These are the historical
-- baselines for change detection. `origin` records provenance:
--   web_evidence        – a verified claim with a quote found in a web_search result
--   conversation_stated – a value stated in a stored message (quote found in that message)
CREATE TABLE IF NOT EXISTS research_snapshots (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  attribute        TEXT NOT NULL,
  attribute_key    TEXT NOT NULL,
  plan             TEXT,
  billing_period   TEXT,
  unit             TEXT,
  region           TEXT,
  currency         TEXT,
  value            TEXT NOT NULL,
  numeric_value    REAL,
  status           TEXT,
  quote            TEXT,
  source_url       TEXT,
  source_type      TEXT,
  observed_at      INTEGER NOT NULL,
  source_date      TEXT,
  confidence       REAL NOT NULL,
  origin           TEXT NOT NULL CHECK (origin IN ('web_evidence', 'conversation_stated'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_entity_key ON research_snapshots(entity_id, attribute_key, observed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_conversation ON research_snapshots(conversation_id);

-- Structured memory with provenance. certainty='inferred' facts are never presented as user statements.
CREATE TABLE IF NOT EXISTS memory_facts (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  content          TEXT NOT NULL,
  certainty        TEXT NOT NULL CHECK (certainty IN ('stated', 'inferred')),
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_conversation ON memory_facts(conversation_id);

CREATE TABLE IF NOT EXISTS search_cache (
  query_hash    TEXT PRIMARY KEY,
  query         TEXT NOT NULL,
  results_json  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_cache_expiry ON search_cache(expires_at);

CREATE TABLE IF NOT EXISTS search_log (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  query            TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  result_count     INTEGER NOT NULL,
  cached           INTEGER NOT NULL,
  attempts         INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_log_conv ON search_log(conversation_id);
