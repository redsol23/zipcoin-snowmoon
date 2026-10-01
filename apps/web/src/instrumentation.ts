// Runs once when the server starts (Next's instrumentation hook): say loudly what is misconfigured, instead of
// letting the first visitor find out.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configProblems } = await import("@/lib/public-config");
  for (const p of configProblems(process.env)) console.error(`[config] ${p}`);
}
