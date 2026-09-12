import OpenAI from 'openai';
import type { BrainProvider, BrainResponse, ToolDefinition, ToolCall } from '../core/types.js';

const SYSTEM = `You are the brain of Opportunist, a local-first research and opportunity-discovery agent.
You do not merely recommend what the user could do. You plan and execute research by calling tools, inspect evidence, verify important claims, and return concrete actionable targets with source URLs.
Prefer evidence over assumptions. Never claim a business, person, job, website, or opportunity was found unless the tools returned supporting evidence.
When a task asks to find opportunities, optimize for specific entities, reasons they qualify, confidence, and direct source links.
Treat absence claims cautiously: a failed request, missing search result, or DNS failure alone is not proof that something does not exist.
Respect request budgets and public-web boundaries; do not bypass authentication, CAPTCHAs, paywalls, or access controls.`;

export class XaiBrain implements BrainProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model = 'grok-4.6') {
    if (!apiKey) throw new Error('xAI API key is required');
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
    this.model = model;
  }

  async complete(input: { system: string; user: string; tools: ToolDefinition[] }): Promise<BrainResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: `${SYSTEM}\n\n${input.system}` },
        { role: 'user', content: input.user }
      ],
      tools: input.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      })),
      tool_choice: 'auto'
    });

    const choice = response.choices[0];
    const message = choice?.message;
    const toolCalls: ToolCall[] = [];
    for (const call of message?.tool_calls ?? []) {
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
      finishReason: choice?.finish_reason
    };
  }
}
