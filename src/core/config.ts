export type Config = {
  groqApiKey: string;
  groqModel: string;
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
    // Groq Free currently lists 30 RPM / 1K RPD / 8K TPM for GPT-OSS 120B.
    // Keep the agent deliberately conservative so one research run does not burst the free quota.
    maxAgentSteps: intEnv('MAX_AGENT_STEPS', 8),
    maxRequests: intEnv('MAX_REQUESTS', 40),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 15000),
    brainMinIntervalMs: intEnv('BRAIN_MIN_INTERVAL_MS', 2500),
    brainMaxOutputTokens: intEnv('BRAIN_MAX_OUTPUT_TOKENS', 1000),
    dataDir: process.env.DATA_DIR ?? './data'
  };
}
