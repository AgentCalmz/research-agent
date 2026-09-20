export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(limited|ltd|incorporated|inc|llc|plc|company|co)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0') && digits.length >= 10) return `234${digits.slice(1)}`;
  return digits;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function tokenSimilarity(a: string, b: string): number {
  const left = new Set(normalizeText(a).split(' ').filter((x) => x.length > 1));
  const right = new Set(normalizeText(b).split(' ').filter((x) => x.length > 1));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.max(left.size, right.size);
}

export function sameEntity(a: { name: string; location?: string; phone?: string }, b: { name: string; location?: string; phone?: string }): boolean {
  const nameScore = tokenSimilarity(a.name, b.name);
  if (a.phone && b.phone && normalizePhone(a.phone) === normalizePhone(b.phone)) return true;
  const sameLocation = Boolean(a.location && b.location && tokenSimilarity(a.location, b.location) >= 0.6);
  return nameScore >= 0.82 || (nameScore >= 0.68 && sameLocation);
}

export function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const redirected = parsed.searchParams.get('uddg');
    if ((parsed.hostname === 'duckduckgo.com' || parsed.hostname.endsWith('.duckduckgo.com')) && redirected) {
      return canonicalizeUrl(decodeURIComponent(redirected));
    }
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source|rut)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}
