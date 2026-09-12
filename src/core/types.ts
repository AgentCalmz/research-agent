export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  toolCallId: string;
  name: string;
  output: unknown;
  error?: string;
};

export type BrainResponse = {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string;
};

export interface BrainProvider {
  complete(input: {
    system: string;
    user: string;
    tools: ToolDefinition[];
  }): Promise<BrainResponse>;
}

export type Source = {
  url: string;
  title?: string;
  sourceType: 'website' | 'directory' | 'social' | 'search' | 'document' | 'other';
  retrievedAt: string;
};

export type Evidence = {
  claim: string;
  source: Source;
  excerpt?: string;
  confidence?: number;
};

export type Opportunity = {
  id: string;
  title: string;
  description: string;
  score: number;
  entities: Record<string, unknown>;
  evidence: Evidence[];
};
