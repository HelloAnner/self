import { readonlyModelDatabase } from "../../infrastructure/model/model-db.ts";
import { topicHistory, topicReport } from "../../infrastructure/topic/topic-query-repository.ts";

export async function readTopicReport(root: string, topicId: string, snapshotId?: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return topicReport(database, topicId, snapshotId);
  } finally {
    database.close();
  }
}

export async function readTopicHistory(root: string, topicId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return topicHistory(database, topicId);
  } finally {
    database.close();
  }
}
