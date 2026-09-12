import { z } from 'zod';

export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  sourceType: z.enum(['website', 'directory', 'social', 'search', 'document', 'other']),
  retrievedAt: z.string().datetime()
});

export const EvidenceSchema = z.object({
  claim: z.string().min(1),
  source: SourceSchema,
  excerpt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional()
});

export const OpportunitySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  score: z.number().min(0).max(10),
  entities: z.record(z.unknown()),
  evidence: z.array(EvidenceSchema)
});
