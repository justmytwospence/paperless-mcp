export interface Chunk {
  text: string;
  /** Character offset of the chunk in the source text. */
  start: number;
  end: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
  countTokens: (text: string) => number;
}

interface Segment {
  start: number;
  end: number;
  tokens: number;
}

// Sentence and paragraph boundaries first, so a chunk rarely cuts a thought in
// half; a single run longer than maxTokens (tables, OCR without punctuation) is
// then split on whitespace.
const BOUNDARY = /(?<=[.!?;:])\s+|\n\s*\n+/g;

function segmentsOf(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let last = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const end = m.index!;
    if (end > last) out.push({ start: last, end });
    last = end + m[0].length;
  }
  if (last < text.length) out.push({ start: last, end: text.length });
  return out;
}

function splitLong(
  text: string,
  seg: { start: number; end: number },
  opts: ChunkOptions
): Segment[] {
  const out: Segment[] = [];
  const words = [...text.slice(seg.start, seg.end).matchAll(/\S+/g)];
  let i = 0;
  while (i < words.length) {
    let j = i;
    let tokens = 0;
    while (j < words.length) {
      const t = opts.countTokens(words[j][0]) || 1;
      if (j > i && tokens + t > opts.maxTokens) break;
      tokens += t;
      j++;
    }
    const start = seg.start + words[i].index!;
    const last = words[j - 1];
    out.push({ start, end: seg.start + last.index! + last[0].length, tokens });
    i = j;
  }
  return out;
}

/**
 * Splits text into chunks of at most `maxTokens` (as counted by `countTokens`),
 * each overlapping the previous by up to `overlapTokens`. There is no cap on the
 * number of chunks: a 900-page book is covered to its last page.
 */
export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  if (!text.trim()) return [];
  const segments: Segment[] = [];
  for (const seg of segmentsOf(text)) {
    const slice = text.slice(seg.start, seg.end);
    if (!slice.trim()) continue;
    const tokens = opts.countTokens(slice);
    if (tokens <= opts.maxTokens) segments.push({ ...seg, tokens });
    else segments.push(...splitLong(text, seg, opts));
  }

  const chunks: Chunk[] = [];
  let i = 0;
  while (i < segments.length) {
    let j = i;
    let tokens = 0;
    while (j < segments.length && (j === i || tokens + segments[j].tokens <= opts.maxTokens)) {
      tokens += segments[j].tokens;
      j++;
    }
    const start = segments[i].start;
    const end = segments[j - 1].end;
    chunks.push({ text: text.slice(start, end), start, end });
    if (j >= segments.length) break;

    // Step back over trailing segments for the overlap, but always advance.
    let k = j;
    let overlap = 0;
    while (k - 1 > i && overlap + segments[k - 1].tokens <= opts.overlapTokens) {
      overlap += segments[k - 1].tokens;
      k--;
    }
    i = k;
  }
  return chunks;
}
