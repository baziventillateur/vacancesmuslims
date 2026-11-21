-- Liste d'attente Vacances Muslims
create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  prenom text not null,
  profil text not null check (profil in ('voyageur', 'proprietaire', 'les_deux')),
  consentement boolean not null default false,
  interets text[] not null default '{}',
  idee text,
  accueille_concepts boolean not null default false,
  confirm_token uuid not null default gen_random_uuid(),
  confirmed_at timestamptz,
  statut text not null default 'en_attente' check (statut in ('en_attente', 'approuve', 'refuse')),
  created_at timestamptz not null default now()
);

create unique index if not exists waitlist_email_key on public.waitlist (lower(email));
create unique index if not exists waitlist_token_key on public.waitlist (confirm_token);

-- Aucune politique : seules les fonctions Edge (clé service) lisent et écrivent.
alter table public.waitlist enable row level security;

-- Si la table existe déjà (installation précédente), ajoute les nouvelles colonnes :
alter table public.waitlist add column if not exists interets text[] not null default '{}';
alter table public.waitlist add column if not exists idee text;
alter table public.waitlist add column if not exists accueille_concepts boolean not null default false;

-- Le profil est demandé après confirmation (page bienvenue.html)
alter table public.waitlist alter column profil drop not null;
