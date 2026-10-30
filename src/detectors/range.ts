export interface TextRange {
  start: number;
  end: number;
}

export function overlaps(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sorts ranges and drops any range overlapping an earlier (or longer, same-start) one. */
export function removeOverlaps<T extends TextRange>(ranges: T[]): T[] {
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: T[] = [];
  for (const range of ranges) {
    const last = result.at(-1);
    if (last && overlaps(last, range)) continue;
    result.push(range);
  }
  return result;
}
