import { createChromaClient, assertChromaAvailable } from "./shared/chroma.ts";
import { requestChatCompletion, requestTranslationCompletion } from "./shared/ollama.ts";
import { getProjectEnv } from "./env.ts";
import type { AskCliArgs } from "./types/cli.types.ts";
import { splitAskIntent } from "./rag/intent.ts";
import { buildPrompt, printParsedIntent, printRetrievedChunks, printSearchAttempts } from "./rag/prompt.ts";
import {
  forceEnglishAnswerInstruction,
  contextAppearsToBeInLanguage,
  localizeNoInfoAnswer,
  resolveTargetAnswerLanguage,
  shouldTranslateAnswer,
  stripOutputLanguageInstruction
} from "./rag/language.ts";
import { resolveStructuredAnswer } from "./rag/logic/ruleEngine.ts";
import { buildContextChunks, runSearchAttempts, selectBestChunks } from "./rag/retrieval.ts";
import { selectSupportChunks } from "./rag/support.ts";
import { hasSufficientContext, normalizeSearchQuery } from "./rag/text.ts";
import { validateAnswer } from "./rag/validation.ts";
import { buildTranslateAnswerPrompt } from "./prompts/translation.prompts.ts";
import {
  buildQueryCacheKey,
  readQueryCache,
  upsertQueryCacheEntry
} from "./shared/cache.ts";

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const env = getProjectEnv();
  const intent = await splitAskIntent(cli.question, cli);
  const targetLanguage = resolveTargetAnswerLanguage(intent.answerInstruction, env.askPreferredLanguage);
  const languageFreeInstruction = stripOutputLanguageInstruction(intent.answerInstruction);
  const baseAnswerInstruction = languageFreeInstruction || env.askDefaultAnswerInstruction;
  const normalizedQuestion = await normalizeSearchQuery(intent.retrievalQuestion, cli);
  const queryCacheKey = buildQueryCacheKey({
    normalizedQuestion,
    answerInstruction: baseAnswerInstruction,
    targetLanguage,
    chatModel: cli.chatModel
  });
  const cachedAnswer = readQueryCache().entries.find((entry) => entry.key === queryCacheKey);
  if (cachedAnswer) {
    if (!cli.answerOnly) {
      printParsedIntent(intent.retrievalQuestion, intent.answerInstruction, {
        ...intent,
        generationAnswerInstruction: cachedAnswer.answerInstruction,
        targetLanguage
      });
      console.log("\n=== Query Cache Hit ===\n");
      console.log(`Created at: ${cachedAnswer.createdAt}`);
      console.log(`Source chunks: ${cachedAnswer.sourceChunkIds.join(", ") || "(none)"}`);
      console.log(cli.chatModel ? `\n=== Answer - ${cli.chatModel} ===\n` : "\n=== Answer ===\n");
    }

    console.log(cachedAnswer.answer.trim());
    return;
  }

  const client = createChromaClient(cli);

  await assertChromaAvailable(
    client,
    cli,
    "Start the Chroma server first."
  );

  const collection = await client.getCollection({
    name: cli.collectionName,
    embeddingFunction: undefined
  });

  const attempts = await runSearchAttempts(collection, {
    ...cli,
    question: intent.retrievalQuestion
  });
  const researchAwareQuestion = [
    normalizedQuestion,
    ...attempts
      .filter((attempt) => attempt.reason.toLowerCase().includes("investigative"))
      .map((attempt) => attempt.query)
  ].filter(Boolean).join(" | ");
  const rankedChunks = selectBestChunks(attempts);
  const supportChunks = await selectSupportChunks(
    researchAwareQuestion,
    baseAnswerInstruction,
    rankedChunks,
    cli
  );
  const investigativeChunks = attempts
    .filter((attempt) => attempt.reason.toLowerCase().includes("investigative"))
    .flatMap((attempt) => attempt.chunks);
  const contextChunks = buildContextChunks(
    [researchAwareQuestion, intent.retrievalQuestion, baseAnswerInstruction].filter(Boolean).join(" | "),
    deduplicateChunksById([...supportChunks, ...investigativeChunks]),
    cli.maxContextChars
  );
  const generateInTargetLanguage = contextAppearsToBeInLanguage(
    contextChunks.map((chunk) => chunk.document),
    targetLanguage
  );
  const generationAnswerInstruction = generateInTargetLanguage && targetLanguage
    ? [baseAnswerInstruction, `answer in ${targetLanguage}`].filter(Boolean).join(", ")
    : forceEnglishAnswerInstruction(baseAnswerInstruction);
  const structuredAnswer = resolveStructuredAnswer({
    question: intent.retrievalQuestion,
    answerInstruction: generationAnswerInstruction,
    chunks: contextChunks
  });
  const enoughContext = hasSufficientContext(researchAwareQuestion, contextChunks);
  const prompt = buildPrompt(intent.retrievalQuestion, generationAnswerInstruction, contextChunks);
  const answerHeader = cli.chatModel
    ? `\n=== Answer - ${cli.chatModel} ===\n`
    : "\n=== Answer ===\n";

  if (!cli.answerOnly) {
    printParsedIntent(intent.retrievalQuestion, intent.answerInstruction, {
      ...intent,
      generationAnswerInstruction,
      targetLanguage
    });
    printSearchAttempts(attempts);
    printRetrievedChunks(contextChunks);
  }

  if (structuredAnswer) {
    const finalStructuredAnswer = generateInTargetLanguage
      ? structuredAnswer
      : await translateAnswerIfNeeded(
        structuredAnswer,
        targetLanguage,
        cli,
        normalizedQuestion
      );

    if (cli.answerOnly) {
      saveQueryCacheEntry(
        queryCacheKey,
        normalizedQuestion,
        baseAnswerInstruction,
        targetLanguage,
        cli.chatModel,
        finalStructuredAnswer,
        contextChunks
      );
      console.log(finalStructuredAnswer.trim());
      return;
    }

    console.log(answerHeader);
    console.log(finalStructuredAnswer.trim());
    saveQueryCacheEntry(
      queryCacheKey,
      normalizedQuestion,
      baseAnswerInstruction,
      targetLanguage,
      cli.chatModel,
      finalStructuredAnswer,
      contextChunks
    );
    return;
  }

  if (!enoughContext) {
    const finalNoInfoAnswer = cli.chatModel
      ? await translateAnswerIfNeeded(env.askNoInfoAnswer, targetLanguage, cli, normalizedQuestion)
      : localizeNoInfoAnswer(env.askNoInfoAnswer, targetLanguage);

    if (cli.answerOnly) {
      console.log(finalNoInfoAnswer);
      return;
    }

    console.log(answerHeader);
    console.log(finalNoInfoAnswer);
    return;
  }

  if (!cli.answerOnly && (cli.showPrompt || !cli.chatModel)) {
    console.log("\n=== Assembled Prompt ===\n");
    console.log(prompt);
  }

  if (!cli.chatModel) {
    if (!cli.answerOnly) {
      console.log("\nNo chat model selected. Pass --chat-model <model> to generate a final answer with Ollama.");
    }
    return;
  }

  const answer = await requestChatCompletion(prompt, cli.ollamaUrl, cli.chatModel);
  if (!cli.answerOnly && cli.showPrompt) {
    console.log("\n=== Draft Answer ===\n");
    console.log(answer.trim());
  }

  const validatedAnswer = await validateAnswer(
    intent.retrievalQuestion,
    generationAnswerInstruction,
    normalizedQuestion,
    contextChunks,
    answer,
    cli
  );
  if (!cli.answerOnly && cli.showPrompt) {
    console.log("\n=== Validated Answer ===\n");
    console.log(validatedAnswer.trim());
  }

  const finalAnswer = generateInTargetLanguage
    ? validatedAnswer
    : await translateAnswerIfNeeded(
      validatedAnswer,
      targetLanguage,
      cli,
      normalizedQuestion
    );

  if (cli.answerOnly) {
    saveQueryCacheEntry(queryCacheKey, normalizedQuestion, baseAnswerInstruction, targetLanguage, cli.chatModel, finalAnswer, contextChunks);
    console.log(finalAnswer.trim());
    return;
  }

  console.log(answerHeader);
  console.log(finalAnswer.trim());
  saveQueryCacheEntry(queryCacheKey, normalizedQuestion, baseAnswerInstruction, targetLanguage, cli.chatModel, finalAnswer, contextChunks);
}

function deduplicateChunksById<T extends { id: string }>(chunks: T[]): T[] {
  const byId = new Map<string, T>();
  for (const chunk of chunks) {
    if (!byId.has(chunk.id)) {
      byId.set(chunk.id, chunk);
    }
  }

  return [...byId.values()];
}

function saveQueryCacheEntry(
  key: string,
  normalizedQuestion: string,
  answerInstruction: string,
  targetLanguage: string,
  chatModel: string | undefined,
  answer: string,
  contextChunks: Array<{ id: string }>
): void {
  if (isNoInfoAnswer(answer)) {
    return;
  }

  upsertQueryCacheEntry({
    key,
    normalizedQuestion,
    answerInstruction,
    targetLanguage,
    chatModel,
    answer: answer.trim(),
    sourceChunkIds: contextChunks.map((chunk) => chunk.id),
    createdAt: new Date().toISOString()
  });
}

function isNoInfoAnswer(answer: string): boolean {
  const normalized = answer.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return (
    normalized.includes("does not contain enough relevant information") ||
    normalized.includes("no contiene suficiente informacion") ||
    normalized.includes("no hay informacion") ||
    normalized.includes("no se encuentra")
  );
}

async function translateAnswerIfNeeded(
  answer: string,
  targetLanguage: string,
  options: { ollamaUrl: string; chatModel?: string },
  sourceTopic?: string
): Promise<string> {
  if (!options.chatModel || !shouldTranslateAnswer(targetLanguage)) {
    return answer;
  }

  const prompt = buildTranslateAnswerPrompt(answer, targetLanguage, sourceTopic);
  return requestTranslationCompletion(prompt, options.ollamaUrl, options.chatModel);
}

function parseCliArgs(args: string[]): AskCliArgs {
  const env = getProjectEnv();
  const positional: string[] = [];
  let question: string | undefined;
  let collectionName = env.chromaCollection;
  let host = env.chromaHost;
  let port = env.chromaPort;
  let ssl = env.chromaSsl;
  let database: string | undefined;
  let tenant: string | undefined;
  let ollamaUrl = env.ollamaUrl;
  let embedModel = env.ollamaEmbedModel;
  let chatModel: string | undefined = env.ollamaChatModel;
  let topK = env.askTopK;
  let maxContextChars = env.askMaxContextChars;
  let showPrompt = false;
  let answerOnly = false;
  let maxSearchAttempts = env.askMaxSearchAttempts;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--question" && next) {
      question = next;
      index += 1;
      continue;
    }

    if (arg === "--collection" && next) {
      collectionName = next;
      index += 1;
      continue;
    }

    if (arg === "--host" && next) {
      host = next;
      index += 1;
      continue;
    }

    if (arg === "--port" && next) {
      port = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--database" && next) {
      database = next;
      index += 1;
      continue;
    }

    if (arg === "--tenant" && next) {
      tenant = next;
      index += 1;
      continue;
    }

    if (arg === "--ssl") {
      ssl = true;
      continue;
    }

    if (arg === "--ollama-url" && next) {
      ollamaUrl = next.replace(/\/+$/, "");
      index += 1;
      continue;
    }

    if (arg === "--embed-model" && next) {
      embedModel = next;
      index += 1;
      continue;
    }

    if (arg === "--chat-model" && next) {
      chatModel = next;
      index += 1;
      continue;
    }

    if (arg === "--top-k" && next) {
      topK = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--max-context-chars" && next) {
      maxContextChars = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--show-prompt") {
      showPrompt = true;
      continue;
    }

    if (arg === "--answer-only") {
      answerOnly = true;
      continue;
    }

    if (arg === "--max-search-attempts" && next) {
      maxSearchAttempts = Number(next);
      index += 1;
      continue;
    }

    positional.push(arg);
  }

  const finalQuestion = question ?? positional.join(" ").trim();

  if (!finalQuestion) {
    throw new Error("Provide a question as text or with --question.");
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("--port must be a positive number.");
  }

  if (!Number.isFinite(topK) || topK <= 0) {
    throw new Error("--top-k must be a positive number.");
  }

  if (!Number.isFinite(maxContextChars) || maxContextChars <= 0) {
    throw new Error("--max-context-chars must be a positive number.");
  }

  if (!Number.isFinite(maxSearchAttempts) || maxSearchAttempts <= 0) {
    throw new Error("--max-search-attempts must be a positive number.");
  }

  return {
    question: finalQuestion,
    collectionName,
    host,
    port,
    ssl,
    database,
    tenant,
    ollamaUrl,
    embedModel,
    chatModel,
    topK,
    maxContextChars,
    showPrompt,
    answerOnly,
    maxSearchAttempts
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
