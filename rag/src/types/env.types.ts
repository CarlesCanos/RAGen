export type ProjectEnv = {
  docsDir: string;
  docsExtensions: string[];
  chunksPath: string;
  pdfToTextBin: string;
  chromaCollection: string;
  chromaHost: string;
  chromaPort: number;
  chromaSsl: boolean;
  ollamaUrl: string;
  ollamaEmbedModel: string;
  ollamaTemperature: number;
  splitTargetChars: number;
  splitMaxChars: number;
  splitOverlapChars: number;
};
