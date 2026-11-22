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


async function notifyAdmins(title: string, body: string) {
  try {
    const m = await readSettings();
    if (!m.vapid_public || !m.vapid_private) return;
    const { data: subs } = await db.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("is_admin", true);
    const payload = JSON.stringify({ title, body, url: "/admin.html", tag: "admin" });
    await Promise.all((subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          { vapidDetails: { subject: "mailto:support@vacancesmuslims.fr", publicKey: m.vapid_public, privateKey: m.vapid_private }, TTL: 3600 });
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st === 404 || st === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
      }
    }));
  } catch { /* les notifications admin ne doivent jamais bloquer */ }
}
async function byToken(token: string) {
  if (!UUID.test(token)) return null;
  const { data } = await db.from("waitlist").select("id,prenom,pwa_installed_at,push_enabled_at").eq("confirm_token", token).maybeSingle();
  return data;
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
    const w = await byToken(token);
    if (w) waitlist_id = w.id;
    const { error } = await db.from("push_subscriptions").upsert({ endpoint, p256dh, auth, waitlist_id, is_admin: false }, { onConflict: "endpoint" });
    if (error) return json({ error: "db" }, 500);
    if (w && !w.push_enabled_at) {
      await db.from("waitlist").update({ push_enabled_at: new Date().toISOString() }).eq("id", w.id);
      await notifyAdmins("Notifications activées", `${w.prenom} a activé les notifications`);
    }
    return json({ status: "ok" });
  }

  // Visite (site ou appli) : un visiteur compté une fois par jour et par page
  if (b.action === "hit") {
    const visitor = String(b.visitor ?? "").slice(0, 64);
    const page = b.page === "app" ? "app" : "site";
    if (visitor.length < 8) return json({ error: "invalid" }, 400);
    const standalone = b.standalone === true;
    const w = await byToken(String(b.token ?? ""));
    await db.from("visits").upsert({ visitor, page, standalone, waitlist_id: w?.id ?? null }, { onConflict: "day,visitor,page", ignoreDuplicates: true });
    if (w) {
      const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
      if (standalone && !w.pwa_installed_at) patch.pwa_installed_at = new Date().toISOString();
      await db.from("waitlist").update(patch).eq("id", w.id);
      if (standalone && !w.pwa_installed_at) await notifyAdmins("Appli installée", `${w.prenom} a installé l'appli`);
    }
    return json({ status: "ok" });
  }

  // Installation détectée (événement « appinstalled »)
  if (b.action === "installed") {
    const w = await byToken(String(b.token ?? ""));
    if (w && !w.pwa_installed_at) {
      await db.from("waitlist").update({ pwa_installed_at: new Date().toISOString() }).eq("id", w.id);
      await notifyAdmins("Appli installée", `${w.prenom} a installé l'appli`);
    }
    return json({ status: "ok" });
  }

  if (b.action === "send") {
    const m = await readSettings();
    if (!m.admin_key || req.headers.get("x-admin-key") !== m.admin_key) return json({ error: "forbidden" }, 403);
    const keys = await vapid();
    const { data: subs } = await db.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("is_admin", false);
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
