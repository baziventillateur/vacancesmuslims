// Panneau admin : connexion par code envoyé par e-mail (un seul e-mail autorisé), stats, inscrits, push.
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const SITE_URL = (Deno.env.get("SITE_URL") || "https://vacancesmuslims.fr").replace(/\/$/, "");
const FROM = Deno.env.get("FROM_EMAIL") ?? "Vacances Muslims <inscription@vacancesmuslims.fr>";
const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") || "baziventillateur@gmail.com").toLowerCase();
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": new URL(SITE_URL).origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function getSet(key: string) {
  const { data } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value as string | undefined;
}
const setSet = (key: string, value: string) => db.from("app_settings").upsert({ key, value }, { onConflict: "key" });
const delSet = (key: string) => db.from("app_settings").delete().eq("key", key);

async function authed(req: Request) {
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (t.length < 20) return false;
  const k = "admin_sess_" + await sha(t);
  const exp = Number(await getSet(k) ?? 0);
  if (!exp || exp < Date.now()) { if (exp) await delSet(k); return false; }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const b = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b) return json({ error: "json" }, 400);
  const action = String(b.action ?? "");

  // 1) Demande de code
  if (action === "request") {
    const email = String(b.email ?? "").trim().toLowerCase();
    let mail = true;
    if (email === ADMIN_EMAIL) {
      const cur = JSON.parse(await getSet("admin_otp") ?? "null") as { at: number } | null;
      if (!cur || Date.now() - cur.at > 30_000) {
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
        await setSet("admin_otp", JSON.stringify({ hash: await sha(code), exp: Date.now() + 10 * 60_000, tries: 0, at: Date.now() }));
        const rr = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM, to: [ADMIN_EMAIL], subject: `Code admin Vacances Muslims : ${code}`,
            html: `<p style="font:16px Arial">Ton code de connexion admin :</p><p style="font:700 34px Arial;letter-spacing:6px">${code}</p><p style="font:13px Arial;color:#666">Valable 10 minutes. Si ce n'est pas toi, ignore ce message.</p>`,
          }),
        }).catch((e) => { console.error("resend fetch", String(e)); return null; });
        if (!rr || !rr.ok) { mail = false; console.error("resend", rr?.status, rr ? await rr.text() : "no response"); }
      }
    }
    return json({ status: "ok", mail });
  }

  // 2) Vérification du code → session de 12 h
  if (action === "verify") {
    const email = String(b.email ?? "").trim().toLowerCase();
    const code = String(b.code ?? "").replace(/\D/g, "");
    const otp = JSON.parse(await getSet("admin_otp") ?? "null") as { hash: string; exp: number; tries: number } | null;
    if (email !== ADMIN_EMAIL || !otp || otp.exp < Date.now() || otp.tries >= 5) return json({ error: "code" }, 401);
    if (await sha(code) !== otp.hash) {
      otp.tries++;
      await setSet("admin_otp", JSON.stringify({ ...otp, at: 0 }));
      return json({ error: "code" }, 401);
    }
    await delSet("admin_otp");
    const token = crypto.randomUUID() + crypto.randomUUID();
    await setSet("admin_sess_" + await sha(token), String(Date.now() + 12 * 3600_000));
    return json({ status: "ok", token });
  }

  // 2 bis) Connexion avec un code perso choisi par l'admin (5 essais, puis blocage 15 min)
  if (action === "login_pin") {
    const email = String(b.email ?? "").trim().toLowerCase();
    const pin = String(b.pin ?? "").replace(/\D/g, "");
    const st = (JSON.parse(await getSet("admin_pin_state") ?? "null") ?? { tries: 0, lock: 0 }) as { tries: number; lock: number };
    const stored = await getSet("admin_pin");
    if (email !== ADMIN_EMAIL || !stored || st.lock > Date.now()) return json({ error: "code" }, 401);
    if (await sha("pin:" + pin) !== stored) {
      st.tries++;
      if (st.tries >= 5) { st.tries = 0; st.lock = Date.now() + 15 * 60_000; }
      await setSet("admin_pin_state", JSON.stringify(st));
      return json({ error: "code" }, 401);
    }
    await setSet("admin_pin_state", JSON.stringify({ tries: 0, lock: 0 }));
    const token = crypto.randomUUID() + crypto.randomUUID();
    await setSet("admin_sess_" + await sha(token), String(Date.now() + 12 * 3600_000));
    return json({ status: "ok", token });
  }

  if (!(await authed(req))) return json({ error: "auth" }, 401);

  if (action === "set_pin") {
    const pin = String(b.pin ?? "");
    if (!/^\d{6,10}$/.test(pin)) return json({ error: "invalid" }, 400);
    const stored = await getSet("admin_pin");
    if (stored) {
      // L'ancien code est exigé pour en choisir un nouveau
      const st = (JSON.parse(await getSet("admin_pin_state") ?? "null") ?? { tries: 0, lock: 0 }) as { tries: number; lock: number };
      if (st.lock > Date.now()) return json({ error: "locked" }, 429);
      if (await sha("pin:" + String(b.old ?? "").replace(/\D/g, "")) !== stored) {
        st.tries++;
        if (st.tries >= 5) { st.tries = 0; st.lock = Date.now() + 15 * 60_000; }
        await setSet("admin_pin_state", JSON.stringify(st));
        return json({ error: "old" }, 403);
      }
    }
    await setSet("admin_pin", await sha("pin:" + pin));
    await setSet("admin_pin_state", JSON.stringify({ tries: 0, lock: 0 }));
    return json({ status: "ok" });
  }
  if (action === "has_pin") return json({ has: !!(await getSet("admin_pin")) });

  if (action === "vapid") return json({ public_key: await getSet("vapid_public") ?? null });

  if (action === "admin_push_subscribe") {
    const endpoint = String(b.endpoint ?? ""), p256dh = String(b.p256dh ?? ""), auth = String(b.auth ?? "");
    let host = "";
    try { host = new URL(endpoint).hostname; } catch { /* invalide */ }
    if (!/(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/.test(host) || !p256dh || !auth) return json({ error: "invalid" }, 400);
    const { error } = await db.from("push_subscriptions").upsert({ endpoint, p256dh, auth, waitlist_id: null, is_admin: true }, { onConflict: "endpoint" });
    return error ? json({ error: "db" }, 500) : json({ status: "ok" });
  }
  if (action === "admin_push_status") {
    const { count } = await db.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("is_admin", true);
    return json({ devices: count ?? 0 });
  }

  if (action === "events") {
    const { data } = await db.from("admin_events").select("id,type,title,detail,waitlist_id,read,created_at").order("created_at", { ascending: false }).limit(Math.min(Number(b.limit) || 30, 200));
    const { count } = await db.from("admin_events").select("id", { count: "exact", head: true }).eq("read", false);
    return json({ events: data ?? [], unread: count ?? 0 });
  }
  if (action === "events_read") {
    await db.from("admin_events").update({ read: true }).eq("read", false);
    return json({ status: "ok" });
  }


  // Relances par e-mail (une seule fois par personne et par type)
  if (action === "relance_count" || action === "relance_send") {
    const type = b.type === "sans_appli" ? "sans_appli" : "non_confirmes";
    const limitDate = new Date(Date.now() - 24 * 3600_000).toISOString();
    let q = db.from("waitlist").select("id,prenom,email,confirm_token").lt("created_at", limitDate);
    q = type === "non_confirmes"
      ? q.is("confirmed_at", null).is("relance_confirm_at", null)
      : q.not("confirmed_at", "is", null).is("pwa_installed_at", null).is("relance_install_at", null);
    const { data: rows } = await q.limit(500);
    const list = rows ?? [];
    if (action === "relance_count") return json({ count: list.length });
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const mk = (r: { prenom: string; email: string; confirm_token: string }) => {
      const lien = `${SITE_URL}/bienvenue.html?t=${r.confirm_token}`;
      const titre = type === "non_confirmes" ? `${esc(r.prenom)}, confirme ton adresse pour garder ta place` : `${esc(r.prenom)}, installe l'appli pour être prévenu(e) en premier`;
      const texte = type === "non_confirmes"
        ? "Tu t'es inscrit(e) sur la liste d'attente Vacances Muslims, mais ton adresse n'est pas encore confirmée. Un clic suffit pour valider ta place."
        : "Ta place est réservée. Installe l'appli sur ton téléphone et active les notifications : tu seras prévenu(e) dès l'ouverture du site, même appli fermée.";
      const bouton = type === "non_confirmes" ? "Confirmer mon adresse" : "Installer l'appli";
      return {
        from: FROM, to: [r.email], subject: type === "non_confirmes" ? "Plus qu'un clic pour garder ta place — Vacances Muslims" : "Sois prévenu(e) en premier — Vacances Muslims",
        html: `<div style="font-family:Arial,sans-serif;background:#F7F4EE;padding:24px"><div style="max-width:480px;margin:auto;background:#fff;border-radius:14px;padding:28px;color:#1D2B2B"><p style="margin:0 0 4px;font-weight:700;color:#0E6A6A">Vacances Muslims</p><h1 style="font-size:21px;margin:8px 0 12px">${titre}</h1><p style="font-size:15px;line-height:1.5;margin:0 0 20px">${texte}</p><p style="margin:0 0 20px"><a href="${lien}" style="display:inline-block;background:#0E6A6A;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${bouton}</a></p><p style="font-size:12px;color:#55625F;margin:0">0 % de commission pendant le lancement. Si tu ne souhaites plus être sur la liste, ignore simplement cet e-mail.</p></div></div>`,
      };
    };
    let sent = 0;
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const r = await fetch("https://api.resend.com/emails/batch", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map(mk)),
      }).catch(() => null);
      if (r && r.ok) {
        sent += chunk.length;
        await db.from("waitlist").update({ [type === "non_confirmes" ? "relance_confirm_at" : "relance_install_at"]: new Date().toISOString() }).in("id", chunk.map((x) => x.id));
      } else console.error("relance batch", r?.status, r ? await r.text() : "no response");
    }
    return json({ status: "ok", sent, total: list.length });
  }

  if (action === "logout") {
    const t = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    await delSet("admin_sess_" + await sha(t));
    return json({ status: "ok" });
  }

  if (action === "stats") {
    const { data: rows } = await db.from("waitlist").select("profil,statut,confirmed_at,created_at,accueille_concepts");
    const r = rows ?? [];
    const days: Record<string, number> = {};
    const now = Date.now();
    for (let i = 13; i >= 0; i--) days[new Date(now - i * 86400000).toISOString().slice(0, 10)] = 0;
    let c24 = 0, c7 = 0;
    for (const x of r) {
      const d = x.created_at.slice(0, 10);
      if (d in days) days[d]++;
      const age = now - new Date(x.created_at).getTime();
      if (age < 86400000) c24++;
      if (age < 7 * 86400000) c7++;
    }
    const { count: push } = await db.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("is_admin", false);
    const since = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
    const { data: vis } = await db.from("visits").select("day,page,visitor,source").gte("day", since).limit(20000);
    const vday: Record<string, { site: number; app: number }> = {};
    for (const d of Object.keys(days)) vday[d] = { site: 0, app: 0 };
    const vv = new Set<string>();
    const srcV: Record<string, Set<string>> = {};
    for (const v of vis ?? []) {
      const d = String(v.day); if (vday[d]) vday[d][v.page as "site" | "app"]++; vv.add(v.visitor);
      const k = v.source || "inconnu"; (srcV[k] ??= new Set()).add(v.visitor);
    }
    const { data: fx } = await db.from("waitlist").select("pwa_installed_at,push_enabled_at,source,confirmed_at");
    const srcI: Record<string, number> = {};
    for (const x of fx ?? []) { const k = (x as { source?: string }).source || "inconnu"; srcI[k] = (srcI[k] ?? 0) + 1; }
    const installes = (fx ?? []).filter((x) => x.pwa_installed_at).length;
    const pushOn = (fx ?? []).filter((x) => x.push_enabled_at).length;
    return json({
      installes, push_actifs: pushOn, visiteurs_14j: vv.size,
      sources: [...new Set([...Object.keys(srcV), ...Object.keys(srcI)])].map((k) => ({ source: k, visiteurs: srcV[k]?.size ?? 0, inscrits: srcI[k] ?? 0 })).sort((a, b) => b.visiteurs + b.inscrits - a.visiteurs - a.inscrits),
      visites: Object.entries(vday).map(([d, v]) => ({ d, site: v.site, app: v.app })),
      total: r.length,
      confirmes: r.filter((x) => x.confirmed_at).length,
      statut: { en_attente: r.filter((x) => x.statut === "en_attente").length, approuve: r.filter((x) => x.statut === "approuve").length, refuse: r.filter((x) => x.statut === "refuse").length },
      profil: { voyageur: r.filter((x) => x.profil === "voyageur").length, proprietaire: r.filter((x) => x.profil === "proprietaire").length, les_deux: r.filter((x) => x.profil === "les_deux").length, non_renseigne: r.filter((x) => !x.profil).length },
      concepts: r.filter((x) => x.accueille_concepts).length,
      dernieres_24h: c24, derniers_7j: c7, push: push ?? 0,
      jours: Object.entries(days).map(([d, n]) => ({ d, n })),
    });
  }

  if (action === "list") {
    const q = String(b.q ?? "").trim().replace(/[%,()]/g, "");
    const limit = Math.min(Number(b.limit) || 8, 500);
    let query = db.from("waitlist")
      .select("id,prenom,email,profil,statut,interets,idee,accueille_concepts,confirmed_at,created_at,pwa_installed_at,push_enabled_at,last_seen_at,source", { count: "exact" })
      .order("created_at", { ascending: false }).range(0, limit - 1);
    if (q) query = query.or(`prenom.ilike.%${q}%,email.ilike.%${q}%`);
    if (b.statut && ["en_attente", "approuve", "refuse"].includes(String(b.statut))) query = query.eq("statut", String(b.statut));
    if (b.confirme === true) query = query.not("confirmed_at", "is", null);
    const { data, count, error } = await query;
    if (error) return json({ error: "db" }, 500);
    return json({ rows: data, count });
  }

  if (action === "set_statut") {
    const st = String(b.statut ?? "");
    if (!["en_attente", "approuve", "refuse"].includes(st)) return json({ error: "invalid" }, 400);
    const { error } = await db.from("waitlist").update({ statut: st }).eq("id", String(b.id ?? ""));
    return error ? json({ error: "db" }, 500) : json({ status: "ok" });
  }

  if (action === "push") {
    const keys = { publicKey: await getSet("vapid_public"), privateKey: await getSet("vapid_private") };
    if (!keys.publicKey || !keys.privateKey) return json({ error: "vapid" }, 500);
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
          { vapidDetails: { subject: "mailto:support@vacancesmuslims.fr", publicKey: keys.publicKey!, privateKey: keys.privateKey! }, TTL: 86400 });
        sent++;
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st === 404 || st === 410) { await db.from("push_subscriptions").delete().eq("id", s.id); removed++; }
      }
    }));
    return json({ status: "ok", sent, removed, total: (subs ?? []).length });
  }

  return json({ error: "action" }, 400);
});
