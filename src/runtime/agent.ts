import type { BrainProvider, BrainResponse, ToolResult } from '../core/types.js';
import { ToolRegistry } from './tools.js';

const MAX_RESULT_CHARS = 1100;
const MAX_CONTEXT_CHARS = 6500;

const DISCOVERY_TOOLS = [
  'search_web',
  'discover_businesses',
  'find_social_profiles'
];

const VERIFICATION_TOOLS = [
  'fetch_url',
  'check_website',
  'crawl_site',
  'find_contact',
  'check_domain',
  'assess_website_presence',
  'score_opportunity',
  'save_opportunity',
  'list_opportunities'
];

function compactValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => compactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => {
      const important = (key: string) => /url|title|name|status|score|confidence|phone|email|domain|claim|snippet|description/i.test(key) ? 0 : 1;
      return important(a) - important(b);
    });
    return Object.fromEntries(entries.slice(0, 16).map(([key, item]) => [key, compactValue(item, depth + 1)]));
  }
  return value;
}

function compactResults(results: ToolResult[]): string {
  return results.map((result) => {
    const payload = JSON.stringify({
      tool: result.name,
      error: result.error,
      output: compactValue(result.output)
    });
    return payload.length > MAX_RESULT_CHARS ? `${payload.slice(0, MAX_RESULT_CHARS)}…` : payload;
  }).join('\n').slice(0, MAX_CONTEXT_CHARS);
}

export class ResearchAgent {
  constructor(
    private readonly brain: BrainProvider,
    private readonly tools: ToolRegistry,
    private readonly maxSteps = 3
  ) {}

  async run(userRequest: string): Promise<string> {
    if (!userRequest.trim()) throw new Error('Research request cannot be empty');

    let context = [
      `Original research objective: ${userRequest}`,
      'Local-first rule: use local tools for anything that does not require model reasoning. Do not send raw web pages through the model.',
      'Phase 1 should discover many candidates in parallel. Phase 2 should verify only the strongest candidates in parallel. Phase 3 should synthesize the final answer without tools.',
      'Keep intermediate output compact. For absence claims, require multiple independent observations.',
      'Return concrete entities, evidence URLs, public contacts, confidence, and opportunity scores when requested.'
    ].join('\n\n');

    let finalText = '';
    const trace: string[] = [];

    for (let step = 1; step <= this.maxSteps; step++) {
      const isFinal = step === this.maxSteps;
      const phaseTools = isFinal ? [] : (step === 1 ? DISCOVERY_TOOLS : VERIFICATION_TOOLS);
      const response: BrainResponse = await this.brain.complete({
        system: [
          `Research phase ${step}/${this.maxSteps}.`,
          step === 1
            ? 'Discovery phase: batch broad but targeted discovery calls. Prefer 2-4 searches/candidate-discovery calls in one response.'
            : isFinal
              ? 'Final phase: do not call tools. Synthesize only from the compact evidence already provided.'
              : 'Verification phase: batch independent checks for the best candidates. Do not rediscover broadly.',
          'Use the smallest number of model calls possible.'
        ].join(' '),
        user: context,
        tools: this.tools.definitions(phaseTools)
      });

      finalText = response.text || finalText;
      trace.push(`phase=${step} toolCalls=${response.toolCalls.length} finish=${response.finishReason ?? 'unknown'}`);

      if (response.toolCalls.length === 0) return finalText || 'The research brain returned no final answer.';

      const results = await Promise.all(
        response.toolCalls.map((call) => this.tools.execute(call.name, call.arguments, call.id))
      );

      context = [
        `Original research objective: ${userRequest}`,
        `Execution trace: ${trace.join('; ')}`,
        'Compact local evidence from the runtime:',
        compactResults(results),
        'Do not repeat raw pages. Prefer new verification actions over duplicate searches.'
      ].join('\n\n').slice(0, MAX_CONTEXT_CHARS);
    }

    return [finalText || 'Research stopped after reaching the execution step limit.', '', `Execution trace: ${trace.join('; ')}`].join('\n');
  }
}
