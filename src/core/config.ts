export type Config = {
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterFallbackModels: string[];
  searchBackend: 'duckduckgo' | 'searxng';
  searxngUrl?: string;
  maxAgentSteps: number;
  maxRequests: number;
  requestTimeoutMs: number;
  brainMinIntervalMs: number;
  brainMaxOutputTokens: number;
  dataDir: string;
};

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function loadConfig(): Config {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required. Copy .env.example to .env and add your OpenRouter API key.');
  }

  const searchBackend = (process.env.SEARCH_BACKEND ?? 'duckduckgo').toLowerCase();
  if (searchBackend !== 'duckduckgo' && searchBackend !== 'searxng') {
    throw new Error('SEARCH_BACKEND must be duckduckgo or searxng');
  }
  if (searchBackend === 'searxng' && !process.env.SEARXNG_URL) {
    throw new Error('SEARXNG_URL is required when SEARCH_BACKEND=searxng');
  }

  const fallbackModels = (process.env.OPENROUTER_FALLBACK_MODELS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    openRouterApiKey,
    openRouterModel: process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4.1-flash',
    openRouterFallbackModels: fallbackModels,
    searchBackend,
    searxngUrl: process.env.SEARXNG_URL,
    maxAgentSteps: intEnv('MAX_AGENT_STEPS', 4),
    maxRequests: intEnv('MAX_REQUESTS', 40),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 15000),
    brainMinIntervalMs: intEnv('BRAIN_MIN_INTERVAL_MS', 750),
    brainMaxOutputTokens: intEnv('BRAIN_MAX_OUTPUT_TOKENS', 900),
    dataDir: process.env.DATA_DIR ?? './data'
  };
}
