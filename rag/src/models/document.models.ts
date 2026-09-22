export type DocumentFormat = "markdown" | "text" | "html" | "pdf";

export type LoadedDocument = {
  format: DocumentFormat;
  text: string;
};
