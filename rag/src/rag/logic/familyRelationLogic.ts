import type {
  StructuredRelationRule
} from "../../models/logic.models.ts";

export const FAMILY_RELATION_RULE: StructuredRelationRule = {
  id: "family-children",
  questionTerms: [
    "parent",
    "parents",
    "father",
    "mother",
    "dad",
    "mom",
    "padre",
    "padres",
    "madre",
    "madres",
    "progenitor",
    "progenitores",
    "child",
    "children",
    "son",
    "daughter",
    "kid",
    "kids",
    "hijo",
    "hijos",
    "hija",
    "hijas",
    "padre",
    "father"
  ],
  relationTerms: [
    "child",
    "children",
    "son",
    "daughter",
    "kid",
    "kids",
    "hijo",
    "hijos",
    "hija",
    "hijas",
    "padre",
    "father"
  ],
  templates: {
    spanish: {
      singular: "Segun la seccion de relaciones de {entity}, su hijo o hija es {items}. {citation}",
      plural: "Segun la seccion de relaciones de {entity}, sus hijos son {items}. {citation}"
    },
    english: {
      singular: "According to the relationships section for {entity}, the child is {items}. {citation}",
      plural: "According to the relationships section for {entity}, the children are {items}. {citation}"
    }
  }
};
