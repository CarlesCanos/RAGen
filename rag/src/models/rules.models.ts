export type RagRules = {
  exampleQueryKeywords: string[];
  broadQuestionKeywords: string[];
  queryNormalizationAliases: Record<string, string>;
  lexicalStopWords: string[];
  requiredTermIgnoredWords: string[];
};
