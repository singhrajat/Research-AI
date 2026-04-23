import dotenv from "dotenv";

dotenv.config();

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  stopAllLogs: parseBooleanEnv(process.env.STOP_ALL_LOGS, false),
  /** Tavily Search API key for Phase 2 web retrieval (optional until execute is called). */
  tavilyApiKey: process.env.TAVILY_API_KEY?.trim() || undefined,
};

