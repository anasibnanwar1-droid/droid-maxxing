function inlineText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function subContent(_match: string, content: string): string {
  const text = inlineText(content.replace(/<br\s*\/?\s*>/gi, ' '));
  if (/cubic free plan|upgrade for unlimited reviews|re-trigger cubic/i.test(text)) return '';
  return text;
}

export function normalizePrCommentBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, subContent)
    .replace(
      /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/gi,
      (_match, summary: string) => `**${inlineText(summary)}**\n\n`,
    )
    .replace(/<\/details>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<p\b[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function prCommentPreview(body: string, maxLength = 110): string {
  const withoutCode = body.replace(/```[\s\S]*?```/g, 'Code details');
  const firstLine = withoutCode
    .split('\n')
    .map((line) => inlineText(line.replace(/^\s{0,3}#{1,6}\s+/, '')))
    .find(Boolean);
  if (!firstLine) return 'Review activity';
  return firstLine.length > maxLength
    ? `${firstLine.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
    : firstLine;
}
