/**
 * Word Error Rate (WER) with Spanish-aware normalization for STT evaluation.
 *
 * Normalization: lowercase, strip accents/diacritics, remove punctuation,
 * collapse whitespace. Both reference and hypothesis go through the same
 * pipeline so punctuation/casing differences never inflate the score.
 *
 * WER = (substitutions + deletions + insertions) / reference words.
 * Computed with the standard Levenshtein alignment at word level.
 */

const PUNCTUATION = /[.,!?¡¿;:()"“”«»…\-–—]/gu;

export function normalizeForWer(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '') // strip combining diacritics
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function wer(reference: string, hypothesis: string): number {
  const ref = normalizeForWer(reference).split(' ').filter(Boolean);
  const hyp = normalizeForWer(hypothesis).split(' ').filter(Boolean);

  if (ref.length === 0 && hyp.length === 0) return 0;
  if (ref.length === 0) return 1; // everything the STT produced is spurious
  if (hyp.length === 0) return 1; // everything was missed

  // dp[i][j] = edit distance between ref[0..i) and hyp[0..j)
  const dp: number[][] = Array.from({ length: ref.length + 1 }, () =>
    new Array<number>(hyp.length + 1).fill(0),
  );
  for (let i = 0; i <= ref.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= hyp.length; j++) dp[0]![j] = j;

  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1, // deletion
        dp[i]![j - 1]! + 1, // insertion
        dp[i - 1]![j - 1]! + cost, // substitution / match
      );
    }
  }

  return dp[ref.length]![hyp.length]! / ref.length;
}
