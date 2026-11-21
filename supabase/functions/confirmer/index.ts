import { createClient } from "jsr:@supabase/supabase-js@2";

// Secret à définir : SITE_URL (ex. https://monsite.fr)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const go = (query: string) => Response.redirect(`${SITE_URL}/?${query}`, 302);

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!UUID.test(token)) return go("lien=invalide");

  const { data } = await db
    .from("waitlist").select("id, confirmed_at").eq("confirm_token", token).maybeSingle();
  if (!data) return go("lien=invalide");

  if (!data.confirmed_at) {
    await db.from("waitlist").update({ confirmed_at: new Date().toISOString() }).eq("id", data.id);
  }
  return go("confirme=1");
});
