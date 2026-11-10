/**
 * Web content is untrusted data. This module neutralizes text that tries to address the
 * model (prompt injection) before it is placed — inside explicit data delimiters — into a prompt.
 * It is one layer of defence; the others are: (1) the system prompt declares source text as data,
 * (2) the verifier only accepts claims whose quote exists in a real result, and (3) the
 * post-processor strips any link/citation that is not a known source.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules?|messages?)/i,
  /disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|system)\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(new|updated|override)\s+(system\s+)?(instructions?|prompt)\b/i,
  /\bsystem\s*prompt\b/i,
  /\b(as\s+an?\s+)?(ai|assistant|language\s+model)[, ]+(you\s+)?(must|should|will)\b/i,
  /<\/?\s*(system|assistant|user|instructions?)\s*>/i,
  /\b(reveal|print|output|leak)\s+(your\s+)?(api\s*key|secret|system\s+prompt|instructions)\b/i,
  /\b(tell|instruct)\s+(the\s+)?user\s+to\b/i,
  /\bdo\s+not\s+(cite|mention)\s+(any\s+)?other\s+sources?\b/i,
];

export interface SanitizedText {
  text: string;
  flagged: boolean;
  flags: string[];
}

export function sanitizeUntrusted(text: string): SanitizedText {
  const flags: string[] = [];
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    const hit = INJECTION_PATTERNS.find((p) => p.test(line));
    if (!hit) return line;
    flags.push(line.trim().slice(0, 160));
    return '[removed: text addressing an AI assistant]';
  });
  // Prevent the content from closing our data delimiter.
  const text2 = out.join('\n').replace(/<\/?\s*untrusted_source[^>]*>/gi, '[tag removed]');
  return { text: text2, flagged: flags.length > 0, flags };
}

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}
