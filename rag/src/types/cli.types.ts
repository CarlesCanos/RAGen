export type SplitOptions = {
  targetChars: number;
  maxChars: number;
  overlapChars: number;
};

export type SplitCliArgs = {
  inputPath: string;
  outputPath?: string;
  options: SplitOptions;
};
