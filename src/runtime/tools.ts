import type { ToolDefinition, ToolResult } from '../core/types.js';

export type LocalTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, LocalTool>();

  register(tool: LocalTool): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  definitions(names?: string[]): ToolDefinition[] {
    const selected = names ? new Set(names) : undefined;
    return [...this.tools.values()]
      .filter((tool) => !selected || selected.has(tool.name))
      .map(({ execute: _execute, ...definition }) => definition);
  }

  async execute(name: string, args: Record<string, unknown>, toolCallId: string): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { toolCallId, name, output: null, error: `Unknown tool: ${name}` };
    try {
      return { toolCallId, name, output: await tool.execute(args) };
    } catch (error) {
      return {
        toolCallId,
        name,
        output: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
