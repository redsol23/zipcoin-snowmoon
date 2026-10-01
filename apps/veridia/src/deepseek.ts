/**
 * A minimal client for DeepSeek's OpenAI-compatible chat completions API, in JSON output mode.
 *
 *   POST {DEEPSEEK_BASE_URL or https://api.deepseek.com}/chat/completions
 *   { model, messages, response_format: { type: "json_object" }, thinking: { type: "enabled" | "disabled" }, ... }
 *
 * JSON mode needs the word "json" and an example of the shape in the prompt, and can occasionally return empty
 * content; callers treat any failure as "no answer" and fall back. The key is read from DEEPSEEK_API_KEY only, sent
 * only in the Authorization header, and never logged; neither are prompts or completions.
 */

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

export class NoKey extends Error {}
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const deepseekKey = () => process.env.DEEPSEEK_API_KEY?.trim() || undefined;

export type ChatOpts = {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  /** DeepSeek models think by default; short in-character lines don't need it */
  thinking?: false | "low" | "high" | "max";
  timeoutMs?: number;
};

/** One chat completion in JSON mode; returns the parsed JSON object. Throws NoKey, LlmError (with HTTP status) or a parse error. */
export async function chatJson(o: ChatOpts): Promise<unknown> {
  const key = deepseekKey();
  if (!key) throw new NoKey("DEEPSEEK_API_KEY is not set");
  const base = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: o.model ?? process.env.VERIDIA_MODEL ?? DEEPSEEK_DEFAULT_MODEL,
    messages: [
      { role: "system", content: o.system },
      { role: "user", content: o.user },
    ],
    response_format: { type: "json_object" },
    max_tokens: o.maxTokens ?? 1000,
    stream: false,
  };
  if (o.thinking) Object.assign(body, { thinking: { type: "enabled" }, reasoning_effort: o.thinking });
  else body.thinking = { type: "disabled" };

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
  } catch (e) {
    // Network errors never include the request, but keep only the first line to be safe
    throw new LlmError(`request failed: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new LlmError(`HTTP ${res.status}`, res.status);
  }
  const j = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  const choice = j.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) throw new LlmError(`empty completion (${choice?.finish_reason ?? "no choice"})`);
  if (choice?.finish_reason === "length") throw new LlmError("completion cut off at max_tokens");
  return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
}
