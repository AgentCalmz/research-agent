import type { BrainProvider } from '../core/types.js';
import { ToolRegistry } from './tools.js';

export class ResearchAgent {
  constructor(
    private readonly brain: BrainProvider,
    private readonly tools: ToolRegistry,
    private readonly maxSteps = 12
  ) {}

  async run(userRequest: string): Promise<string> {
    let context = userRequest;
    let finalText = '';

    for (let step = 0; step < this.maxSteps; step++) {
      const response = await this.brain.complete({
        system: `Execute the user's research objective. Use tools whenever factual discovery or verification is needed. Work iteratively. Do not invent results.\nAvailable execution environment: local PC.`,
        user: context,
        tools: this.tools.definitions()
      });

      finalText = response.text || finalText;
      if (response.toolCalls.length === 0) return finalText;

      const results = [];
      for (const call of response.toolCalls) {
        const result = await this.tools.execute(call.name, call.arguments, call.id);
        results.push(result);
      }

      context = [
        `Original request: ${userRequest}`,
        `Previous brain response: ${response.text}`,
        'Tool results:',
        JSON.stringify(results, null, 2),
        'Continue the investigation. Verify uncertain claims and only finish when you have an actionable answer with source links.'
      ].join('\n\n');
    }

    return finalText || 'Research stopped after reaching the execution step limit.';
  }
}
