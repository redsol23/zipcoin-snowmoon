// One chat-completions call to DeepSeek's OpenAI-compatible API, with plain fetch. Server-only: the key never leaves
// this process. Docs: https://api-docs.deepseek.com/ (base URL, models), .../api/create-chat-completion/ (request),
// .../guides/tool_calls/ (tools), .../guides/thinking_mode (reasoning_content must be sent back with tools).
import type { Usage } from "./budget";
import type { ToolSpec } from "./tools";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** DeepSeek's general chat model; EMERALD_MODEL overrides it (e.g. deepseek-v4-pro). */
export const DEFAULT_MODEL = "deepseek-flash";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; reasoning_content?: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Most output tokens one call may produce; the budget reserves this much per call */
export const MAX_TOKENS = 8000;
export const modelName = () => process.env.EMERALD_MODEL || DEFAULT_MODEL;

export type ChatResult = { message: Extract<ChatMessage, { role: "assistant" }>; finish_reason: string; usage?: Usage };

/** A failure the route can map to a status and a plain sentence. */
export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The OpenAI "function" tool format. Not strict: DeepSeek's strict mode needs its beta base URL and doesn't list null
 * among its schema types, and every proposal is re-validated in the browser before a card appears anyway.
 */
export const toOpenAITools = (tools: ToolSpec[]) => tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

export async function chat(o: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; fetch?: typeof fetch }): Promise<ChatResult> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new ChatError(503, "Emerald isn't set up on this server yet (it needs a DeepSeek API key).");
  const base = (process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL).replace(/\/$/, "");
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: modelName(),
        messages: [{ role: "system", content: o.system }, ...o.messages],
        tools: toOpenAITools(o.tools),
        tool_choice: "auto",
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new ChatError(502, "Emerald couldn't reach its model. Try again.");
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new ChatError(503, "Emerald isn't set up on this server yet (its DeepSeek API key was refused).");
    if (res.status === 402) throw new ChatError(503, "Emerald's model account is out of credit. Tell whoever runs this server.");
    if (res.status === 429) throw new ChatError(429, "Emerald is busy right now. Try again in a moment.");
    if (res.status === 400 || res.status === 422) throw new ChatError(400, "Emerald couldn't read that conversation. Start a new one.");
    throw new ChatError(502, `Emerald couldn't answer (${res.status}). Try again.`);
  }
  const j = (await res.json()) as { choices?: { message: ChatResult["message"]; finish_reason: string }[]; usage?: Usage };
  const c = j.choices?.[0];
  if (!c?.message) throw new ChatError(502, "Emerald's model sent an empty answer. Try again.");
  return { message: c.message, finish_reason: c.finish_reason, usage: j.usage };
}
