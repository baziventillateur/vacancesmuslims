// Notifications push (Web Push) : clé publique, abonnement, envoi (réservé à l'admin).
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = (Deno.env.get("SITE_URL") || "https://vacancesmuslims.fr").replace(/\/$/, "");
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": new URL(SITE_URL).origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Seuls les services de notification des navigateurs sont acceptés.
const HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readSettings() {
  const { data } = await db.from("app_settings").select("key,value");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value as string]));
}
async function vapid() {
  let m = await readSettings();
  if (m.vapid_public && m.vapid_private) return { publicKey: m.vapid_public, privateKey: m.vapid_private };
  const g = webpush.generateVAPIDKeys();
  await db.from("app_settings").upsert(
    [{ key: "vapid_public", value: g.publicKey }, { key: "vapid_private", value: g.privateKey }],
    { onConflict: "key", ignoreDuplicates: true },
  );
  m = await readSettings();
  return { publicKey: m.vapid_public, privateKey: m.vapid_private };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const b = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b) return json({ error: "json" }, 400);

  if (b.action === "init") return json({ public_key: (await vapid()).publicKey });

  if (b.action === "subscribe") {
    const endpoint = String(b.endpoint ?? ""), p256dh = String(b.p256dh ?? ""), auth = String(b.auth ?? "");
    let host = "";
    try { host = new URL(endpoint).hostname; } catch { /* invalide */ }
    if (!HOSTS.test(host) || endpoint.length > 600 || p256dh.length > 200 || auth.length > 100 || !p256dh || !auth) {
      return json({ error: "invalid" }, 400);
    }
    let waitlist_id: string | null = null;
    const token = String(b.token ?? "");
    if (UUID.test(token)) {
      const { data } = await db.from("waitlist").select("id").eq("confirm_token", token).not("confirmed_at", "is", null).maybeSingle();
      waitlist_id = data?.id ?? null;
    }
    const { error } = await db.from("push_subscriptions").upsert({ endpoint, p256dh, auth, waitlist_id }, { onConflict: "endpoint" });
    if (error) return json({ error: "db" }, 500);
    return json({ status: "ok" });
  }

  if (b.action === "send") {
    const m = await readSettings();
    if (!m.admin_key || req.headers.get("x-admin-key") !== m.admin_key) return json({ error: "forbidden" }, 403);
    const keys = await vapid();
    const { data: subs } = await db.from("push_subscriptions").select("id,endpoint,p256dh,auth");
    const payload = JSON.stringify({
      title: String(b.title ?? "Vacances Muslims").slice(0, 80),
      body: String(b.body ?? "").slice(0, 200),
      url: String(b.url ?? "/app.html").slice(0, 300),
      tag: "annonce",
    });
    let sent = 0, removed = 0;
    await Promise.all((subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          { vapidDetails: { subject: "mailto:support@vacancesmuslims.fr", ...keys }, TTL: 86400 });
        sent++;
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st === 404 || st === 410) { await db.from("push_subscriptions").delete().eq("id", s.id); removed++; }
      }
    }));
    return json({ status: "ok", sent, removed });
  }

  return json({ error: "action" }, 400);
});
