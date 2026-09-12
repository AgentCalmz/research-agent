import { loadConfig } from './core/config.js';
import { XaiBrain } from './brain/xai.js';
import { DuckDuckGoSearch, SearxngSearch } from './discovery/search.js';
import { ResearchAgent } from './runtime/agent.js';
import { registerBuiltinTools } from './runtime/builtin-tools.js';
import { registerDiscoveryTools } from './runtime/discovery-tools.js';
import { configureHttp } from './runtime/http.js';
import { OpportunityStore } from './runtime/store.js';
import { ToolRegistry } from './runtime/tools.js';

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

  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  registerDiscoveryTools(registry, search, new OpportunityStore(config.dataDir));

  const agent = new ResearchAgent(
    new XaiBrain(config.xaiApiKey, config.xaiModel),
    registry,
    config.maxAgentSteps
  );

  console.log(await agent.run(request));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
