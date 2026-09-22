import { getProjectEnv } from "./env.ts";

const env = getProjectEnv();

console.log(JSON.stringify({
  chatModel: env.ollamaChatModel,
  embedModel: env.ollamaEmbedModel
}));
