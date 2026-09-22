import type {
  EntityBlock,
  StructuredAnswerResolverInput,
  StructuredRelationRule
} from "../../models/logic.models.ts";
import { extractRequestedLanguageFromInstruction } from "../language.ts";
import { canonicalizeToken, extractProtectedTerms, normalizeTerms, tokenizeLoose } from "../text.ts";
import { extractEntityBlocks } from "./entityParser.ts";
import { FAMILY_RELATION_RULE } from "./familyRelationLogic.ts";

const STRUCTURED_RELATION_RULES = [
  FAMILY_RELATION_RULE
];

export function resolveStructuredAnswer(input: StructuredAnswerResolverInput): string | null {
  const entityBlocks = extractEntityBlocks(input.chunks);

  for (const rule of STRUCTURED_RELATION_RULES) {
    const answer = resolveRelationRule(input, entityBlocks, rule);
    if (answer) {
      return answer;
    }
  }

  return null;
}

function resolveRelationRule(
  input: StructuredAnswerResolverInput,
  blocks: EntityBlock[],
  rule: StructuredRelationRule
): string | null {
  if (!questionMatchesRule(input.question, rule)) {
    return null;
  }

  const targetTerms = getTargetEntityTerms(input.question);
  if (targetTerms.length === 0) {
    return null;
  }

  const targetBlock = findBestMatchingEntityBlock(targetTerms, blocks);
  const familyQuestionIntent = detectFamilyQuestionIntent(input.question);

  if (familyQuestionIntent === "father" || familyQuestionIntent === "mother" || familyQuestionIntent === "parent") {
    return resolveInverseFamilyRelation(
      blocks,
      targetTerms,
      input.answerInstruction,
      familyQuestionIntent,
      rule
    );
  }

  if (!targetBlock) {
    return null;
  }

  const relatedEntities = targetBlock.relations
    .filter((relation) => relationLabelMatchesRule(relation.label, rule))
    .map((relation) => relation.entity);
  const uniqueRelatedEntities = [...new Set(relatedEntities)];
  if (uniqueRelatedEntities.length === 0) {
    return null;
  }

  return formatRelationAnswer(targetBlock, uniqueRelatedEntities, input.answerInstruction, rule);
}

function detectFamilyQuestionIntent(question: string): "children" | "parent" | "father" | "mother" | null {
  const tokens = tokenizeLoose(question);

  if (hasAnyToken(tokens, ["father", "dad", "padre"])) {
    return "father";
  }

  if (hasAnyToken(tokens, ["mother", "mom", "madre"])) {
    return "mother";
  }

  if (hasAnyToken(tokens, ["parent", "parents", "padres", "madres", "progenitor", "progenitores"])) {
    return "parent";
  }

  if (hasAnyToken(tokens, ["child", "children", "son", "daughter", "kid", "kids", "hijo", "hijos", "hija", "hijas"])) {
    return "children";
  }

  return null;
}

function questionMatchesRule(question: string, rule: StructuredRelationRule): boolean {
  const tokens = tokenizeLoose(question);
  return rule.questionTerms.some((term) => tokens.includes(canonicalizeToken(term)));
}

function relationLabelMatchesRule(label: string, rule: StructuredRelationRule): boolean {
  const tokens = tokenizeLoose(label);
  return rule.relationTerms.some((term) => tokens.includes(canonicalizeToken(term)));
}

function resolveInverseFamilyRelation(
  blocks: EntityBlock[],
  targetTerms: string[],
  answerInstruction: string,
  intent: "parent" | "father" | "mother",
  rule: StructuredRelationRule
): string | null {
  const candidates = blocks.filter((block) =>
    block.relations.some((relation) =>
      relationLabelMatchesRule(relation.label, rule) &&
      targetTerms.some((term) => tokenizeLoose(relation.entity).includes(term))
    )
  );

  const filteredCandidates = intent === "parent"
    ? candidates
    : candidates.filter((block) => entityMatchesParentGender(block, intent));
  const uniqueEntities = [...new Map(
    filteredCandidates.map((block) => [block.entityName, block])
  ).values()];

  if (uniqueEntities.length === 0) {
    return null;
  }

  return formatInverseFamilyAnswer(uniqueEntities, answerInstruction, intent);
}

function getTargetEntityTerms(question: string): string[] {
  const protectedTerms = extractProtectedTerms(question);
  if (protectedTerms.length > 0) {
    return protectedTerms;
  }

  return normalizeTerms(question).filter((term) => term.length >= 5);
}

function findBestMatchingEntityBlock(targetTerms: string[], blocks: EntityBlock[]): EntityBlock | null {
  const candidates = blocks
    .map((block) => ({
      block,
      score: scoreEntityBlock(targetTerms, block)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.block ?? null;
}

function scoreEntityBlock(targetTerms: string[], block: EntityBlock): number {
  const entityTokens = tokenizeLoose(block.entityName);
  const relationTokens = tokenizeLoose(block.relations.map((relation) => relation.entity).join(" "));
  let score = 0;

  for (const term of targetTerms) {
    if (entityTokens.includes(term)) {
      score += 5;
      continue;
    }

    if (relationTokens.includes(term)) {
      score += 1;
    }
  }

  return score;
}

function formatRelationAnswer(
  block: EntityBlock,
  relatedEntities: string[],
  answerInstruction: string,
  rule: StructuredRelationRule
): string {
  const language = extractRequestedLanguageFromInstruction(answerInstruction).toLowerCase();
  const templates = language === "spanish" ? rule.templates.spanish : rule.templates.english;
  const template = relatedEntities.length === 1 ? templates.singular : templates.plural;

  return template
    .replace("{entity}", block.entityName)
    .replace("{items}", joinNames(relatedEntities, language === "spanish" ? "y" : "and"))
    .replace("{citation}", `[${block.chunkId}]`);
}

function formatInverseFamilyAnswer(
  blocks: EntityBlock[],
  answerInstruction: string,
  intent: "parent" | "father" | "mother"
): string {
  const language = extractRequestedLanguageFromInstruction(answerInstruction).toLowerCase();
  const entities = blocks.map((block) => block.entityName);
  const citations = [...new Set(blocks.map((block) => `[${block.chunkId}]`))].join(" ");
  const joinedEntities = joinNames(entities, language === "spanish" ? "y" : "and");

  if (language === "spanish") {
    if (intent === "father") {
      return `Segun la seccion de relaciones, el padre es ${joinedEntities}. ${citations}`;
    }

    if (intent === "mother") {
      return `Segun la seccion de relaciones, la madre es ${joinedEntities}. ${citations}`;
    }

    return `Segun la seccion de relaciones, los padres son ${joinedEntities}. ${citations}`;
  }

  if (intent === "father") {
    return `According to the relationships section, the father is ${joinedEntities}. ${citations}`;
  }

  if (intent === "mother") {
    return `According to the relationships section, the mother is ${joinedEntities}. ${citations}`;
  }

  return `According to the relationships section, the parents are ${joinedEntities}. ${citations}`;
}

function entityMatchesParentGender(
  block: EntityBlock,
  intent: "father" | "mother"
): boolean {
  const normalizedContent = canonicalizeToken(block.content);

  if (intent === "father") {
    return /\b(?:genero|gender):\s*hombre\b/.test(normalizedContent);
  }

  return /\b(?:genero|gender):\s*mujer\b/.test(normalizedContent);
}

function hasAnyToken(tokens: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.includes(canonicalizeToken(candidate)));
}

function joinNames(values: string[], conjunction: string): string {
  if (values.length === 0) {
    return "";
  }

  if (values.length === 1) {
    return values[0];
  }

  if (values.length === 2) {
    return `${values[0]} ${conjunction} ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")} ${conjunction} ${values.at(-1)}`;
}
