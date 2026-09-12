import type { BrainProvider } from '../core/types.js';
import { ToolRegistry } from './tools.js';

export class ResearchAgent {
  constructor(
    private readonly brain: BrainProvider,
    private readonly tools: ToolRegistry,
    private readonly maxSteps = 20
  ) {}

  async run(userRequest: string): Promise<string> {
    if (!userRequest.trim()) throw new Error('Research request cannot be empty');

    let context = [
      `Original research objective: ${userRequest}`,
      'You are operating a local-first research runtime.',
      'Use tools to discover and verify facts. When the objective asks for opportunities, return concrete entities, evidence, confidence, and source URLs.',
      'Do not infer absence from a single failed request. Triangulate important claims.',
      'When you have enough evidence, stop calling tools and provide the result.'
    ].join('\n\n');

    let finalText = '';
    const trace: string[] = [];

    for (let step = 1; step <= this.maxSteps; step++) {
      const response = await this.brain.complete({
        system: `Research execution step ${step}/${this.maxSteps}. Keep work bounded and evidence-driven. Available environment: local PC.`,
        user: context,
        tools: this.tools.definitions()
      });

      finalText = response.text || finalText;
      trace.push(`step=${step} toolCalls=${response.toolCalls.length} finish=${response.finishReason ?? 'unknown'}`);

      if (response.toolCalls.length === 0) {
        return finalText || 'The research brain returned no final answer.';
      }

      const results = await Promise.all(
        response.toolCalls.map((call) => this.tools.execute(call.name, call.arguments, call.id))
      );

      context = [
        `Original research objective: ${userRequest}`,
        `Execution trace: ${trace.join('; ')}`,
        `Brain note from previous step: ${response.text || '(none)'}`,
        'Authoritative tool results from the local runtime:',
        JSON.stringify(results, null, 2),
        'Continue the investigation. Cross-check uncertain claims, prioritize independent sources, and only finish when the answer is actionable and source-linked.'
      ].join('\n\n');
    }

    return [
      finalText || 'Research stopped after reaching the execution step limit.',
      '',
      `Execution trace: ${trace.join('; ')}`
    ].join('\n');
  }
}
