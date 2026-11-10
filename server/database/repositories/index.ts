import type { DB } from '../connection.js';
import { ConversationRepository } from './conversations.js';
import { MessageRepository } from './messages.js';
import { EntityRepository } from './entities.js';
import { SnapshotRepository } from './snapshots.js';
import { FactRepository, SearchLogRepository, SummaryRepository } from './memory.js';

export interface Repositories {
  db: DB;
  conversations: ConversationRepository;
  messages: MessageRepository;
  entities: EntityRepository;
  snapshots: SnapshotRepository;
  facts: FactRepository;
  summaries: SummaryRepository;
  searchLog: SearchLogRepository;
}

export function createRepositories(db: DB): Repositories {
  return {
    db,
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    entities: new EntityRepository(db),
    snapshots: new SnapshotRepository(db),
    facts: new FactRepository(db),
    summaries: new SummaryRepository(db),
    searchLog: new SearchLogRepository(db),
  };
}
