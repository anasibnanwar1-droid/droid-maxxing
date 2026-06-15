export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
export type ToolHandlerResult = string | { content: ToolContent[]; isError?: boolean };

export function safeTool<T>(
  handler: (input: T) => Promise<ToolHandlerResult> | ToolHandlerResult,
): (input: T) => Promise<ToolHandlerResult> {
  return async (input: T) => {
    try {
      return await handler(input);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: jsonResult({ ok: false, error: errMsg(err) }) }],
      };
    }
  };
}

export function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
