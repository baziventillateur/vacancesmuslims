import { createClient } from "jsr:@supabase/supabase-js@2";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILS = ["voyageur", "proprietaire", "les_deux"];
const CONCEPTS = ["mamans", "deux_familles", "ressourcement", "fetes", "amis"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "json" }, 400); }

  const token = String(b.token ?? "");
  if (!UUID.test(token)) return json({ error: "token" }, 400);

  const { data: row } = await db.from("waitlist")
    .select("id, prenom, profil, confirmed_at").eq("confirm_token", token).maybeSingle();
  if (!row) return json({ error: "token" }, 404);

  // Le lien de l'e-mail ouvre la page ; c'est elle qui confirme (un scanner de liens ne confirme donc rien).
  if (b.action === "confirm") {
    if (!row.confirmed_at) await db.from("waitlist").update({ confirmed_at: new Date().toISOString() }).eq("id", row.id);
    return json({ status: "ok", prenom: row.prenom, profil: row.profil });
  }
  if (!row.confirmed_at) return json({ error: "token" }, 404);

  if (b.action === "get") return json({ prenom: row.prenom, profil: row.profil });

  const patch: Record<string, unknown> = {};
  if (typeof b.profil === "string" && PROFILS.includes(b.profil)) patch.profil = b.profil;
  if (Array.isArray(b.interets)) {
    patch.interets = [...new Set(b.interets.filter((x): x is string => typeof x === "string" && CONCEPTS.includes(x)))];
  }
  if (typeof b.idee === "string") patch.idee = b.idee.trim().slice(0, 200) || null;
  if (typeof b.accueil === "boolean") patch.accueille_concepts = b.accueil;
  if (Object.keys(patch).length) {
    const { error } = await db.from("waitlist").update(patch).eq("id", row.id);
    if (error) return json({ error: "db" }, 500);
  }
  return json({ status: "ok" });
});
