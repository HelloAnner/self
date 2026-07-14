import {
  readonlyModelDatabase,
  writableModelDatabase,
} from "../../infrastructure/model/model-db.ts";
import {
  createTopic,
  listTopics,
  topicView,
  updateTopic,
} from "../../infrastructure/topic/topic-lifecycle-repository.ts";

export async function createTopicDefinition(
  root: string,
  input: {
    name: string;
    scope?: string;
    exclude?: string;
    description?: string;
    aliases?: string[];
  },
) {
  const database = await writableModelDatabase(root);
  try {
    return createTopic(database, input);
  } finally {
    database.close();
  }
}

export async function updateTopicDefinition(
  root: string,
  topicId: string,
  input: { scope?: string; exclude?: string; addAlias?: string; ifVersion?: number },
) {
  const database = await writableModelDatabase(root);
  try {
    return updateTopic(database, topicId, input);
  } finally {
    database.close();
  }
}

export async function showTopic(root: string, topicId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return topicView(database, topicId);
  } finally {
    database.close();
  }
}

export async function showTopics(root: string, status?: string, limit?: number) {
  const database = await readonlyModelDatabase(root);
  try {
    return listTopics(database, status, limit);
  } finally {
    database.close();
  }
}
