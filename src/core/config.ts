export type BrainProviderName = 'openrouter' | 'deepseek';

export type Config = {
  brainProvider: BrainProviderName;
  openRouterApiKey?: string;
  openRouterModel: string;
  openRouterFallbackModels: string[];
  deepSeekApiKey?: string;
  deepSeekModel: string;
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
  const brainProvider = (process.env.BRAIN_PROVIDER ?? 'openrouter').toLowerCase();
  if (brainProvider !== 'openrouter' && brainProvider !== 'deepseek') {
    throw new Error('BRAIN_PROVIDER must be openrouter or deepseek');
  }

  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;

  if (brainProvider === 'openrouter' && !openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required when BRAIN_PROVIDER=openrouter.');
  }
  if (brainProvider === 'deepseek' && !deepSeekApiKey) {
    throw new Error('DEEPSEEK_API_KEY is required when BRAIN_PROVIDER=deepseek.');
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
    brainProvider,
    openRouterApiKey,
    openRouterModel: process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4.1-flash',
    openRouterFallbackModels: fallbackModels,
    deepSeekApiKey,
    deepSeekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    searchBackend,
    searxngUrl: process.env.SEARXNG_URL,
    maxAgentSteps: intEnv('MAX_AGENT_STEPS', 3),
    maxRequests: intEnv('MAX_REQUESTS', 40),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 15000),
    brainMinIntervalMs: intEnv('BRAIN_MIN_INTERVAL_MS', 750),
    brainMaxOutputTokens: intEnv('BRAIN_MAX_OUTPUT_TOKENS', 900),
    dataDir: process.env.DATA_DIR ?? './data'
  };
}
