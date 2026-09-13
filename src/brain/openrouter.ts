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

export class OpenRouterBrain implements BrainProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly fallbackModels: string[];
  private readonly minIntervalMs: number;
  private readonly maxOutputTokens: number;
  private lastCallAt = 0;

  constructor(
    apiKey: string,
    model = 'deepseek/deepseek-v4.1-flash',
    fallbackModels: string[] = [],
    minIntervalMs = 750,
    maxOutputTokens = 900
  ) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/AgentCalmz/research-agent',
        'X-Title': 'Opportunist Research Agent'
      }
    });
    this.model = model;
    this.fallbackModels = fallbackModels;
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

    const body = {
      model: this.model,
      ...(this.fallbackModels.length > 0 ? { models: this.fallbackModels } : {}),
      max_tokens: this.maxOutputTokens,
      messages: [
        { role: 'system' as const, content: `${SYSTEM}\n\n${input.system}` },
        { role: 'user' as const, content: input.user }
      ],
      tools: input.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      })),
      tool_choice: 'auto' as const
    };

    const response = await this.client.chat.completions.create(body);
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
        toolCalls.push({ id: call.id, name: call.function.name, arguments: {} });
      }
    }

    return {
      text: message?.content ?? '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : (response.choices[0]?.finish_reason ?? 'completed')
    };
  }
}
