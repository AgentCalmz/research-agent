import { XaiBrain } from './brain/xai.js';
import { ResearchAgent } from './runtime/agent.js';
import { registerBuiltinTools } from './runtime/builtin-tools.js';
import { ToolRegistry } from './runtime/tools.js';

const request = process.argv.slice(2).join(' ').trim();

if (!request) {
  console.error('Usage: npm start -- "your research objective"');
  process.exit(1);
}

try {
  const registry = registerBuiltinTools(new ToolRegistry());
  const agent = new ResearchAgent(new XaiBrain(), registry);
  const result = await agent.run(request);
  console.log(result);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
