import OpenAI from 'openai';
import type { BrainProvider, BrainResponse, ToolDefinition, ToolCall } from '../core/types.js';

const SYSTEM = `You are the brain of Opportunist, a local-first research and opportunity-discovery agent.
You are a decision layer, not a web crawler. Local tools perform discovery, fetching, DNS, extraction, scoring, and storage.
Use tools to discover and verify facts, then return concrete actionable targets with evidence and source URLs.
Prefer evidence over assumptions. Never claim a business, person, job, website, or opportunity was found unless tools returned supporting evidence.
Treat absence claims cautiously: one failed request, missing search result, or DNS failure is not proof of absence.
When several independent tool calls are useful at the same stage, request them together.
Keep intermediate reasoning concise and make the smallest number of model calls needed.
Respect public-web boundaries; do not bypass authentication, CAPTCHAs, paywalls, or access controls.`;

export class DeepSeekBrain implements BrainProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly minIntervalMs: number;
  private readonly maxOutputTokens: number;
  private lastCallAt = 0;

  constructor(
    apiKey: string,
    model = 'deepseek-flash',
    minIntervalMs = 750,
    maxOutputTokens = 900
  ) {
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required');
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.deepseek.com'
    });
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

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxOutputTokens,
      thinking: { type: 'disabled' as const },
      messages: [
        { role: 'system', content: `${SYSTEM}\n\n${input.system}` },
        { role: 'user', content: input.user }
      ],
      tools: input.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false
        }
      })),
      tool_choice: input.tools.length > 0 ? 'required' : 'none'
    });

    const message = response.choices[0]?.message;
    const toolCalls: ToolCall[] = [];

    for (const call of message?.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      try {
        toolCalls.push({
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
        });
      } catch {
        toolCalls.push({
          id: call.id,
          name: call.function.name,
          arguments: {}
        });
      }
    }

    return {
      text: message?.content ?? '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : (response.choices[0]?.finish_reason ?? 'completed')
    };
  }
}
