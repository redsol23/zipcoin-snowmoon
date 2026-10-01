// Live story feed: polls the Veridia service and forwards new events to the browser over SSE.
import { services, type WorldEvent } from "@/lib/veridia";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const who = new URL(req.url).searchParams.get("who");
  const enc = new TextEncoder();
  let since = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const poll = async () => {
        try {
          const res = await fetch(`${services.veridia}/feed?since=${since}`, { cache: "no-store" });
          const events = ((await res.json()) as WorldEvent[]).filter((e) => !who || e.who === who);
          for (const e of events) {
            since = Math.max(since, e.at);
            // Only the fields the told story has: nothing else is forwarded, even if a service sent it
            const to = typeof e.detail?.to === "string" ? e.detail.to : undefined;
            send("event", { at: e.at, who: e.who, action: e.action, line: e.line, when: e.when, ...(to ? { detail: { to } } : {}) });
          }
          send("ping", { ok: true });
        } catch {
          send("down", { ok: false });
        }
      };
      await poll();
      timer = setInterval(poll, 2000);
    },
    cancel() {
      clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
