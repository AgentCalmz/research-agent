import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Opportunity } from '../core/types.js';

export class OpportunityStore {
  private readonly file: string;

  constructor(private readonly dataDir = './data') {
    this.file = join(dataDir, 'opportunities.jsonl');
  }

  async save(opportunity: Opportunity): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(this.file, JSON.stringify(opportunity) + '\n', 'utf8');
  }

  async list(limit = 50): Promise<Opportunity[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      return raw.split('\n').filter(Boolean).slice(-limit).reverse().map((line) => JSON.parse(line) as Opportunity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
