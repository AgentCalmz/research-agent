export type Config = {
  groqApiKey: string;
  groqModel: string;
  searchBackend: 'duckduckgo' | 'searxng';
  searxngUrl?: string;
  maxAgentSteps: number;
  maxRequests: number;
  requestTimeoutMs: number;
  dataDir: string;
};

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function loadConfig(): Config {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('GROQ_API_KEY is required. Copy .env.example to .env and add your Groq API key.');

  const searchBackend = (process.env.SEARCH_BACKEND ?? 'duckduckgo').toLowerCase();
  if (searchBackend !== 'duckduckgo' && searchBackend !== 'searxng') {
    throw new Error('SEARCH_BACKEND must be duckduckgo or searxng');
  }

  if (searchBackend === 'searxng' && !process.env.SEARXNG_URL) {
    throw new Error('SEARXNG_URL is required when SEARCH_BACKEND=searxng');
  }

  return {
    groqApiKey,
    groqModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
    searchBackend,
    searxngUrl: process.env.SEARXNG_URL,
    maxAgentSteps: intEnv('MAX_AGENT_STEPS', 20),
    maxRequests: intEnv('MAX_REQUESTS', 60),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 15000),
    dataDir: process.env.DATA_DIR ?? './data'
  };
}
