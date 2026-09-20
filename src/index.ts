import 'dotenv/config';
import { loadConfig } from './core/config.js';
import { OpenRouterBrain } from './brain/openrouter.js';
import { DeepSeekBrain } from './brain/deepseek.js';
import { DuckDuckGoSearch, SearxngSearch } from './discovery/search.js';
import { OpportunityHunter } from './opportunity/hunter.js';
import { configureHttp } from './runtime/http.js';
import { OpportunityStore } from './runtime/store.js';

const request = process.argv.slice(2).join(' ').trim();

if (!request) {
  console.error('Usage: npm start -- "your research objective"');
  process.exit(1);
}

try {
  const config = loadConfig();
  configureHttp(config.maxRequests);

  const search = config.searchBackend === 'searxng'
    ? new SearxngSearch(config.searxngUrl!)
    : new DuckDuckGoSearch();

  const brain = config.brainProvider === 'deepseek'
    ? new DeepSeekBrain(
        config.deepSeekApiKey!,
        config.deepSeekModel,
        config.brainMinIntervalMs,
        config.brainMaxOutputTokens
      )
    : new OpenRouterBrain(
        config.openRouterApiKey!,
        config.openRouterModel,
        config.openRouterFallbackModels,
        config.brainMinIntervalMs,
        config.brainMaxOutputTokens
      );

  const hunter = new OpportunityHunter(brain, search, new OpportunityStore(config.dataDir));
  console.log(await hunter.run(request));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
