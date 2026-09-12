import OpenAI from 'openai';
import type { BrainProvider, BrainResponse, ToolDefinition, ToolCall } from '../core/types.js';

const SYSTEM = `You are the brain of Opportunist, a local-first research and opportunity-discovery agent.
You do not merely recommend what the user could do. You plan and execute research by calling local tools, inspect evidence, verify important claims, and return concrete actionable targets with source URLs.
Prefer evidence over assumptions. Never claim a business, person, job, website, or opportunity was found unless tools returned supporting evidence.
When a task asks to find opportunities, optimize for specific entities, why they qualify, confidence, and direct source links.
Treat absence claims cautiously: a failed request, missing search result, or DNS failure alone is not proof that something does not exist.
When several independent tool calls are useful at the same stage, make them in the same turn instead of taking one tiny step at a time.
Keep intermediate notes concise; save detail for the final answer.
Respect request budgets and public-web boundaries; do not bypass authentication, CAPTCHAs, paywalls, or access controls.`;

export class GroqBrain implements BrainProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly minIntervalMs: number;
  private readonly maxOutputTokens: number;
  private lastCallAt = 0;

  constructor(
    apiKey: string,
    model = 'openai/gpt-oss-120b',
    minIntervalMs = 3000,
    maxOutputTokens = 900
  ) {
    if (!apiKey) throw new Error('GROQ_API_KEY is required');
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
    this.model = model;
    this.minIntervalMs = minIntervalMs;
    this.maxOutputTokens = maxOutputTokens;
  }

  private async pace(): Promise<void> {
    const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastCallAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastCallAt = Date.now();
  }

  async complete(input: { system: string; user: string; tools: ToolDefinition[] }): Promise<BrainResponse> {
    await this.pace();

    const response = await this.client.responses.create({
      model: this.model,
      max_output_tokens: this.maxOutputTokens,
      reasoning: { effort: 'low' },
      parallel_tool_calls: true,
      input: [
        { role: 'system', content: `${SYSTEM}\n\n${input.system}` },
        { role: 'user', content: input.user }
      ],
      tools: input.tools.map((tool) => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false
      })),
      tool_choice: 'auto'
    });

    const toolCalls: ToolCall[] = [];
    for (const item of response.output ?? []) {
      if (!item || item.type !== 'function_call') continue;
      try {
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          arguments: JSON.parse(item.arguments || '{}') as Record<string, unknown>
        });
      } catch {
        toolCalls.push({ id: item.call_id, name: item.name, arguments: {} });
      }
    }

    return {
      text: response.output_text ?? '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'completed'
    };
  }
}
