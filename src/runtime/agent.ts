import type { BrainProvider, BrainResponse, ToolResult } from '../core/types.js';
import { ToolRegistry } from './tools.js';

const MAX_RESULT_CHARS = 1400;
const MAX_CONTEXT_CHARS = 8500;

function compactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > 700 ? `${value.slice(0, 700)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => {
      const important = (key: string) => /url|title|name|status|score|confidence|phone|email|domain|claim|snippet|description/i.test(key) ? 0 : 1;
      return important(a) - important(b);
    });
    return Object.fromEntries(entries.slice(0, 20).map(([key, item]) => [key, compactValue(item, depth + 1)]));
  }
  return value;
}

function compactResults(results: ToolResult[]): string {
  return results.map((result) => {
    const payload = JSON.stringify({
      tool: result.name,
      toolCallId: result.toolCallId,
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
    private readonly maxSteps = 4
  ) {}

  async run(userRequest: string): Promise<string> {
    if (!userRequest.trim()) throw new Error('Research request cannot be empty');

    let context = [
      `Original research objective: ${userRequest}`,
      'Use local tools for web discovery and verification. The model is a decision layer, not a transport for raw web pages.',
      'Batch independent tool calls in one response whenever possible.',
      'For absence claims, require multiple independent observations.',
      'Return concrete entities, evidence URLs, public contacts, confidence, and opportunity scores when requested.',
      'Do not finish until the available evidence is sufficient or genuinely exhausted.'
    ].join('\n\n');

    let finalText = '';
    const trace: string[] = [];

    for (let step = 1; step <= this.maxSteps; step++) {
      const response: BrainResponse = await this.brain.complete({
        system: [
          `Research phase ${step}/${this.maxSteps}.`,
          'Minimize LLM calls. Prefer several independent tool calls in the same response instead of one-call-at-a-time investigation.',
          'Only compact evidence summaries are returned between phases; use their URLs and key facts.',
          step === this.maxSteps
            ? 'This is the final phase. Synthesize an evidence-backed answer and avoid further tool calls.'
            : 'Continue investigating with batched tools unless enough verified evidence exists.'
        ].join(' '),
        user: context,
        tools: this.tools.definitions()
      });

      finalText = response.text || finalText;
      trace.push(`step=${step} toolCalls=${response.toolCalls.length} finish=${response.finishReason ?? 'unknown'}`);

      if (response.toolCalls.length === 0) return finalText || 'The research brain returned no final answer.';

      const results = await Promise.all(
        response.toolCalls.map((call) => this.tools.execute(call.name, call.arguments, call.id))
      );

      context = [
        `Original research objective: ${userRequest}`,
        `Execution trace: ${trace.join('; ')}`,
        `Previous model note: ${(response.text || '(none)').slice(0, 700)}`,
        'Compact authoritative tool results from the local runtime:',
        compactResults(results),
        step === this.maxSteps - 1
          ? 'Prepare the final evidence-backed answer from the compact results. Do not request raw pages.'
          : 'Choose the next batched verification actions. Avoid duplicate searches and do not repeat raw content already seen.'
      ].join('\n\n').slice(0, MAX_CONTEXT_CHARS);
    }

    return [finalText || 'Research stopped after reaching the execution step limit.', '', `Execution trace: ${trace.join('; ')}`].join('\n');
  }
}
