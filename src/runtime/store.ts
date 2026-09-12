import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpportunitySchema } from '../core/schemas.js';
import type { Opportunity } from '../core/types.js';

export class OpportunityStore {
  private readonly file: string;

  constructor(private readonly dataDir = './data') {
    this.file = join(dataDir, 'opportunities.jsonl');
  }

  async save(opportunity: Opportunity): Promise<void> {
    const validated = OpportunitySchema.parse(opportunity);
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(this.file, JSON.stringify(validated) + '\n', 'utf8');
  }

  async list(limit = 50): Promise<Opportunity[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const lines = raw.split('\n').filter(Boolean).slice(-limit).reverse();
      return lines.map((line) => OpportunitySchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
