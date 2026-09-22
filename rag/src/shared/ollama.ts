import type {
  ChatRequestOptions,
  EmbedRequestOptions,
  OllamaChatResponse,
  OllamaEmbedResponse
} from "../types/ollama.types.ts";
import { getProjectEnv } from "../env.ts";
import {
  GROUNDED_RAG_SYSTEM_PROMPT,
  JSON_ONLY_SYSTEM_PROMPT,
  TRANSLATION_SYSTEM_PROMPT
} from "../prompts/ollama.prompts.ts";

export async function requestEmbeddings(
  input: string[],
  options: EmbedRequestOptions
): Promise<number[][]> {
  const response = await fetch(`${options.baseUrl}/api/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: options.model,
      input,
      truncate: options.truncate ?? true,
      ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {})
    })
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      options.unreachableMessage ??
        `Could not reach Ollama at ${options.baseUrl}. Original error: ${message}`
    );
  });

  const payload = (await response.json().catch(() => null)) as OllamaEmbedResponse | null;
  if (!response.ok) {
    const errorMessage = payload?.error ?? `${response.status} ${response.statusText}`;
    throw new Error(`Ollama embedding request failed: ${errorMessage}`);
  }

  if (!payload?.embeddings) {
    throw new Error("Ollama returned an unexpected embedding response.");
  }

  return payload.embeddings;
}

export async function requestChatCompletion(
  prompt: string,
  ollamaUrl: string,
  model: string
): Promise<string> {
  return requestChat({
    ollamaUrl,
    model,
    prompt,
    systemPrompt: GROUNDED_RAG_SYSTEM_PROMPT
  });
}

export async function requestJsonChatCompletion(
  prompt: string,
  ollamaUrl: string,
  model: string
): Promise<string> {
  return requestChat({
    ollamaUrl,
    model,
    prompt,
    format: "json",
    systemPrompt: JSON_ONLY_SYSTEM_PROMPT
  });
}

export async function requestTranslationCompletion(
  prompt: string,
  ollamaUrl: string,
  model: string
): Promise<string> {
  return requestChat({
    ollamaUrl,
    model,
    prompt,
    systemPrompt: TRANSLATION_SYSTEM_PROMPT
  });
}

async function requestChat(options: ChatRequestOptions): Promise<string> {
  const response = await fetch(`${options.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: options.model,
      stream: false,
      think: false,
      options: {
        temperature: options.temperature ?? getProjectEnv().ollamaTemperature
      },
      ...(options.format ? { format: options.format } : {}),
      messages: [
        {
          role: "system",
          content: options.systemPrompt
        },
        {
          role: "user",
          content: options.prompt
        }
      ]
    })
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach Ollama at ${options.ollamaUrl}. Original error: ${message}`);
  });

  const payload = (await response.json().catch(() => null)) as OllamaChatResponse | null;
  if (!response.ok) {
    throw new Error(`Ollama chat request failed: ${payload?.error ?? response.statusText}`);
  }

  const content = payload?.message?.content?.trim();
  const thinking = payload?.message?.thinking?.trim();

  if (options.format === "json") {
    if (!content) {
      throw new Error("Ollama returned an empty JSON chat response.");
    }

    return content;
  }

  if (!content && !thinking) {
    throw new Error("Ollama returned an empty chat response.");
  }

  return content || thinking || "";
}
