// Service-role Supabase client and the request guard every runtime function uses.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.46.1";
import { env } from "./env.ts";

let client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Only the scheduler (x-cron-secret == CRON_SECRET) or a caller presenting the service-role key
 * itself may run a runtime function. Both are compared in constant time. The functions are deployed
 * with platform JWT verification off, because a JWT alone proves nothing here: the public anon key
 * is a valid JWT too, and it must be refused.
 */
export function authorize(req: Request): Response | null {
  const cron = env("CRON_SECRET");
  const given = req.headers.get("x-cron-secret") ?? "";
  if (cron && timingSafeEqual(given, cron)) return null;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  if (bearer && timingSafeEqual(bearer, service)) return null;
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function heartbeat(id: string, detail: unknown) {
  const { error } = await db().from("heartbeats").upsert({ id, last_run: new Date().toISOString(), detail });
  if (error) console.error(`heartbeat ${id}: ${error.message}`);
}

/** Run a handler behind the guard; errors become a 500 with the message, never a crash. */
export function serve(
  name: string,
  handler: (req: Request, body: Record<string, unknown>) => Promise<unknown>,
  publicAccess = false,
) {
  Deno.serve(async (req) => {
    if (!publicAccess) {
      const denied = authorize(req);
      if (denied) return denied;
    }
    try {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return json({ ok: true, ...(await handler(req, body as Record<string, unknown>) as object) });
    } catch (e) {
      console.error(`${name} failed:`, e);
      return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) }, 500);
    }
  });
}
