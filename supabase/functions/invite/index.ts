import { createClient } from "jsr:@supabase/supabase-js@2";

// Invitations d'amis : un seul e-mail par adresse, jamais relancé.
// L'adresse de l'invité n'est PAS conservée : seule son empreinte (SHA-256) l'est,
// pour ne jamais l'inviter deux fois et respecter un refus.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const SITE_URL = (Deno.env.get("SITE_URL") || "https://vacancesmuslims.fr").replace(/\/$/, "");
const FROM = Deno.env.get("FROM_EMAIL") ?? "Vacances Muslims <inscription@vacancesmuslims.fr>";
const MAX_PAR_ENVOI = 5, MAX_PAR_PERSONNE = 10, MAX_PAR_JOUR = 300;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": new URL(SITE_URL).origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function hash(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("inv:" + s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function mail(prenom: string, optout: string) {
  const p = esc(prenom);
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${p} t'invite sur Vacances Muslims</title></head>
<body style="margin:0;padding:0;background:#082C2C;"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${p} pense que ça peut te plaire : des maisons privées, sans vis-à-vis, avec paiement sécurisé.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#082C2C" style="background:#082C2C;background-image:linear-gradient(160deg,#0E6A6A 0%,#0B3D3D 45%,#041E1F 100%);"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="540" cellpadding="0" cellspacing="0" style="width:100%;max-width:540px;">
<tr><td align="center" style="padding:0 0 18px;"><img src="${SITE_URL}/assets/icon-192.png" width="64" height="64" alt="Vacances Muslims" style="display:block;border:0;border-radius:17px;box-shadow:0 12px 24px rgba(0,0,0,.45);"><div style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:700;color:#ffffff;padding-top:11px;">Vacances <span style="color:#E7BD70;">Muslims</span></div></td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:24px;box-shadow:0 24px 48px rgba(0,0,0,.45);">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td height="5" bgcolor="#C8923B" style="height:5px;line-height:5px;font-size:0;background:#C8923B;border-radius:24px 24px 0 0;">&nbsp;</td></tr>
<tr><td style="padding:32px 32px 6px;font-family:Arial,Helvetica,sans-serif;color:#1D2B2B;">
<div style="font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#C8923B;">Une invitation</div>
<h1 style="margin:10px 0 12px;font-size:26px;line-height:1.2;color:#082C2C;">${p} pense à toi pour tes prochaines vacances</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#40504E;">${p} vient de rejoindre la liste d'attente de <b>Vacances Muslims</b> et a pensé que ça pouvait te plaire.</p>
<p style="margin:0 0 6px;font-size:15px;line-height:1.6;color:#40504E;">&#10003; Des maisons privées, sans vis-à-vis, avec piscine<br>&#10003; Un paiement sécurisé, fini les virements à l'aveugle<br>&#10003; 0&nbsp;% de commission Vacances Muslims pendant le lancement</p>
</td></tr>
<tr><td align="center" style="padding:20px 32px 8px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#C8923B" style="border-radius:14px;background:#C8923B;background-image:linear-gradient(180deg,#F0C77C,#C8923B);">
<a href="${SITE_URL}/?src=invite" style="display:inline-block;padding:15px 30px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:#2A1A00;text-decoration:none;">Rejoindre la liste d'attente &rarr;</a></td></tr></table></td></tr>
<tr><td style="padding:14px 32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.6;color:#7A8784;">${p} a saisi ton adresse e-mail pour t'envoyer cette invitation. C'est le seul message que tu recevras : nous ne la conservons pas et ne t'écrirons plus, sauf si tu t'inscris.<br><a href="${optout}" style="color:#0E6A6A;text-decoration:underline;">Ne plus jamais recevoir d'invitation</a></td></tr>
</table></td></tr></table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "json" }, 400); }

  // Désinscription d'une invitation (lien de l'e-mail)
  if (b.action === "optout") {
    const k = String(b.k ?? "");
    if (!UUID.test(k)) return json({ error: "invalid" }, 400);
    await db.from("invitations").update({ opted_out: true }).eq("unsub_token", k);
    return json({ status: "ok" });
  }

  const token = String(b.token ?? "");
  if (!UUID.test(token)) return json({ error: "invalid" }, 400);
  const { data: me } = await db.from("waitlist").select("id,email,prenom,confirmed_at").eq("confirm_token", token).maybeSingle();
  if (!me || !me.confirmed_at) return json({ error: "invalid" }, 403);

  const list = Array.isArray(b.emails) ? b.emails : [];
  const uniq = [...new Set(list.map((e) => String(e ?? "").trim().toLowerCase()).filter((e) => e.length <= 254 && EMAIL.test(e) && e !== me.email))].slice(0, MAX_PAR_ENVOI);
  if (!uniq.length) return json({ error: "no_email" }, 400);

  const { count: deja } = await db.from("invitations").select("id", { count: "exact", head: true }).eq("inviter_id", me.id);
  const reste = MAX_PAR_PERSONNE - (deja ?? 0);
  if (reste <= 0) return json({ status: "limit", sent: 0 });
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const { count: jour } = await db.from("invitations").select("id", { count: "exact", head: true }).gte("created_at", today.toISOString());
  if ((jour ?? 0) >= MAX_PAR_JOUR) return json({ status: "busy", sent: 0 });

  const prenom = String(me.prenom ?? "").replace(/[\r\n<>]/g, " ").trim().slice(0, 40) || "Un proche";
  const batch: unknown[] = [];
  const ids: string[] = [];
  for (const email of uniq.slice(0, reste)) {
    const h = await hash(email);
    const { data: known } = await db.from("waitlist").select("id").eq("email", email).maybeSingle();
    if (known) continue;
    const { data: row, error } = await db.from("invitations").insert({ inviter_id: me.id, email_hash: h }).select("id,unsub_token").single();
    if (error || !row) continue;
    ids.push(row.id);
    batch.push({
      from: FROM, to: [email], subject: `${prenom} t'invite sur Vacances Muslims`,
      html: mail(prenom, `${SITE_URL}/desinscription.html?k=${row.unsub_token}`),
      headers: { "List-Unsubscribe": `<${SITE_URL}/desinscription.html?k=${row.unsub_token}>` },
    });
  }
  if (batch.length) {
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(batch),
    });
    if (!r.ok) { await db.from("invitations").delete().in("id", ids); return json({ error: "email" }, 502); }
  }
  return json({ status: "ok", sent: batch.length });
});
