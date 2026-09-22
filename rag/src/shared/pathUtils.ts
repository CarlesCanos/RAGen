import path from "node:path";

export function normalizeForJson(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
