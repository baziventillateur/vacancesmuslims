import { createClient } from "jsr:@supabase/supabase-js@2";

// Secrets à définir : RESEND_API_KEY, SITE_URL (ex. https://monsite.fr), FROM_EMAIL (facultatif)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const SITE_URL = (Deno.env.get("SITE_URL") || "https://vacancesmuslims.fr").replace(/\/$/, "");
const FROM = Deno.env.get("FROM_EMAIL") ?? "Vacances Muslims <inscription@vacancesmuslims.fr>";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": new URL(SITE_URL).origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const LANGS = ["fr"];
const cache = new Map<string, { at: number; html: string }>();
async function template(lang: string) {
  const hit = cache.get(lang);
  if (hit && Date.now() - hit.at < 300000) return hit.html;
  try {
    const r = await fetch(`${SITE_URL}/emails/${lang}/confirmation.html`);
    if (r.ok) { const html = await r.text(); cache.set(lang, { at: Date.now(), html }); return html; }
  } catch { /* repli ci-dessous */ }
  return null;
}

function emailHtml(prenom: string, lien: string) {
  return `<div style="font-family:Arial,sans-serif;background:#F7F4EE;padding:24px">
  <div style="max-width:480px;margin:auto;background:#fff;border-radius:14px;padding:28px;color:#1D2B2B">
    <p style="margin:0 0 4px;font-weight:700;color:#0E6A6A">Vacances Muslims</p>
    <h1 style="font-size:22px;margin:8px 0 12px">Plus qu'une étape, ${esc(prenom)}</h1>
    <p style="font-size:15px;line-height:1.5;margin:0 0 20px">Confirme ton adresse e-mail pour valider ton inscription sur la liste d'attente.</p>
    <p style="margin:0 0 20px"><a href="${lien}" style="display:inline-block;background:#0E6A6A;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Confirmer mon e-mail</a></p>
    <p style="font-size:13px;line-height:1.5;color:#55625F;margin:0">Une fois ton adresse confirmée, nous examinons ton inscription et revenons vers toi d'ici quelques jours.<br><br>Si tu n'es pas à l'origine de cette demande, ignore simplement cet e-mail.</p>
  </div></div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "json" }, 400); }

  // Piège anti-robots : le champ caché doit rester vide
  if (typeof b.website === "string" && b.website.trim() !== "") return json({ status: "ok" });

  const prenom = String(b.prenom ?? "").trim().slice(0, 60);
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!prenom || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || b.consent !== true) {
    return json({ error: "invalid" }, 400);
  }

  const { data: existing, error: e1 } = await db
    .from("waitlist").select("id, confirm_token, confirmed_at").eq("email", email).maybeSingle();
  if (e1) return json({ error: "db" }, 500);

  if (existing?.confirmed_at) return json({ status: "deja_confirme" });

  let token: string;
  if (existing) {
    token = existing.confirm_token;
    await db.from("waitlist").update({ prenom }).eq("id", existing.id);
  } else {
    const { data, error } = await db
      .from("waitlist").insert({ email, prenom, consentement: true })
      .select("confirm_token").single();
    if (error || !data) return json({ error: "db" }, 500);
    token = data.confirm_token;
  }

  const lien = `${SITE_URL}/bienvenue.html?t=${token}`;
  const lang = LANGS.includes(String(b.lang ?? "")) ? String(b.lang) : "fr";
  const tpl = await template(lang);
  const html = tpl ? tpl.replaceAll("{{prenom}}", esc(prenom)).replaceAll("{{lien}}", lien) : emailHtml(prenom, lien);
  const subject = tpl?.match(/<title>(.*?)<\/title>/s)?.[1]?.trim() || "Confirme ton inscription — Vacances Muslims";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject,
      html,
    }),
  });
  if (!r.ok) return json({ error: "email" }, 502);

  return json({ status: "ok" });
});
