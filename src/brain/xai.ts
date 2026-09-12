import OpenAI from 'openai';
import type { BrainProvider, BrainResponse, ToolDefinition, ToolCall } from '../core/types.js';

const SYSTEM = `You are the brain of Opportunist, a local-first research and opportunity-discovery agent.
You do not merely recommend what the user could do. You plan and execute research by calling tools, inspect evidence, verify important claims, and return concrete actionable targets with source URLs.
Prefer evidence over assumptions. Never claim a business, person, job, website, or opportunity was found unless the tools returned supporting evidence.
When a task asks to find opportunities, optimize for specific entities, reasons they qualify, confidence, and direct source links.`;

export class XaiBrain implements BrainProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey = process.env.XAI_API_KEY, model = process.env.XAI_MODEL ?? 'grok-4.6') {
    if (!apiKey) throw new Error('XAI_API_KEY is required');
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

    const message = response.choices[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
    }));

    return {
      text: message?.content ?? '',
      toolCalls,
      finishReason: response.choices[0]?.finish_reason
    };
  }
}
