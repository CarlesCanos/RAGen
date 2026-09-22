export function extractRequestedLanguageFromInstruction(instruction: string): string {
  const match = instruction.match(/\banswer in\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)*)/i);
  return normalizeLanguageName(match?.[1]?.trim() ?? "");
}

export function resolveTargetAnswerLanguage(answerInstruction: string, preferredLanguage: string): string {
  return extractRequestedLanguageFromInstruction(answerInstruction) || normalizeLanguageName(preferredLanguage);
}

export function stripOutputLanguageInstruction(answerInstruction: string): string {
  return answerInstruction
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !/^answer in\s+/i.test(part))
    .join(", ");
}

export function forceEnglishAnswerInstruction(answerInstruction: string): string {
  const stripped = stripOutputLanguageInstruction(answerInstruction);
  return [stripped, "answer in English"].filter(Boolean).join(", ");
}

export function shouldTranslateAnswer(targetLanguage: string): boolean {
  const normalized = normalizeLanguageName(targetLanguage).toLowerCase();
  return Boolean(normalized) && normalized !== "english";
}

export function contextAppearsToBeInLanguage(texts: string[], language: string): boolean {
  const normalizedLanguage = normalizeLanguageName(language).toLowerCase();
  const joinedText = texts.join(" ").toLowerCase();

  if (!joinedText.trim()) {
    return false;
  }

  if (normalizedLanguage === "spanish") {
    const matches = joinedText.match(
      /\b(?:nombre|descripcion|descripci[oó]n|relaciones|actualidad|pasado|familia|pareja|hombre|mujer|estado|vivo|viva|ciudad|reino|ejercito|ej[eé]rcito|magia|del|que|con|una|sus)\b/g
    );
    return (matches?.length ?? 0) >= 8;
  }

  return false;
}

export function localizeNoInfoAnswer(defaultAnswer: string, targetLanguageOrInstruction: string): string {
  const language = (
    extractRequestedLanguageFromInstruction(targetLanguageOrInstruction) ||
    normalizeLanguageName(targetLanguageOrInstruction)
  ).toLowerCase();

  if (language === "spanish") {
    return "La documentacion no contiene suficiente informacion relevante para responder esa pregunta.";
  }

  if (language === "catalan") {
    return "La documentacio no conte prou informacio rellevant per respondre aquesta pregunta.";
  }

  if (language === "french") {
    return "La documentation ne contient pas assez d'informations pertinentes pour repondre a cette question.";
  }

  if (language === "german") {
    return "Die Dokumentation enthaelt nicht genuegend relevante Informationen, um diese Frage zu beantworten.";
  }

  if (language === "italian") {
    return "La documentazione non contiene informazioni rilevanti sufficienti per rispondere a questa domanda.";
  }

  if (language === "portuguese") {
    return "A documentacao nao contem informacoes relevantes suficientes para responder a essa pergunta.";
  }

  return defaultAnswer;
}

function normalizeLanguageName(language: string): string {
  const normalized = language.trim().toLowerCase();

  if (!normalized) {
    return "";
  }

  const aliases: Record<string, string> = {
    en: "English",
    english: "English",
    es: "Spanish",
    spanish: "Spanish",
    espanol: "Spanish",
    ca: "Catalan",
    catala: "Catalan",
    catalan: "Catalan",
    fr: "French",
    french: "French",
    frances: "French",
    de: "German",
    german: "German",
    aleman: "German",
    it: "Italian",
    italian: "Italian",
    italiano: "Italian",
    pt: "Portuguese",
    portuguese: "Portuguese",
    portugues: "Portuguese"
  };

  return aliases[normalized] ?? language.trim();
}
