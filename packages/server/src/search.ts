/** Reciprocal rank fusion over ranked id lists (k=60). Higher score = better. */
export function rrf(lists: string[][], k = 60): { id: string; score: number }[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...score].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
}
