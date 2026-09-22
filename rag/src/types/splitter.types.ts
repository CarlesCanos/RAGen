export type Block =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string | null };

export type Section = {
  heading: string;
  sectionPath?: string[];
  level: number;
  blocks: Block[];
};
