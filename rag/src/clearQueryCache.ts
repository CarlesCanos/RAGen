import { getProjectEnv } from "./env.ts";
import { clearQueryCache } from "./shared/cache.ts";

clearQueryCache();
console.log(`Cleared query cache at ${getProjectEnv().queryCachePath}`);
