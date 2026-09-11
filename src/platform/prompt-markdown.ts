/**
 * Prompt-file markdown preprocessing. Operator prompt files double as
 * documentation, so `<!-- ... -->` annotations are removed before the text is
 * composed into a system prompt: the note explains a rule to humans without
 * spending model context on it. Text outside comments is preserved verbatim,
 * except that a line carrying nothing but an annotation disappears with it.
 *
 * The configuration loader still hashes the raw file, so a comment-only edit
 * remains visible in the config hash.
 */

const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
/**
 * Marks where a comment was removed so a line that carried nothing else can be
 * dropped together with it, instead of leaving a blank gap in the prompt. NUL
 * never occurs in real content: the loader rejects it in prompt files, so the
 * marker cannot be confused with text.
 */
const COMMENT_MARKER = '\u0000';

/**
 * Removes HTML comments from prompt markdown. Lenient by design: an
 * unterminated `<!--` has no matching `-->`, so it is not an annotation and
 * stays in the prompt verbatim.
 */
export function stripHtmlComments(markdown: string): string {
  if (!markdown.includes('<!--')) {
    return markdown;
  }
  const lines: string[] = [];
  for (const line of markdown.replace(HTML_COMMENT_PATTERN, COMMENT_MARKER).split('\n')) {
    if (!line.includes(COMMENT_MARKER)) {
      lines.push(line);
      continue;
    }
    const content = line.replaceAll(COMMENT_MARKER, '');
    if (content.trim().length > 0) {
      lines.push(content);
    }
  }
  return lines.join('\n');
}
