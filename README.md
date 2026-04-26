# Hyrox Epicure Manager (GitHub Pages)

Site statique pour la gestion de la compétition **Hyrox Epicure** au club (parcours 6 zones, format inspiré Hyrox).

## Pages incluses

- `index.html` : portail d’accès (athlètes / organisation)
- `dashboard.html` : redirection vers une entité TV externe si configurée
- `tv.html` : écran live TV
- `equipes.html` : gestion des équipes (solo, Double, Mixte)
- `planning.html` : planning des heats
- `epreuves.html` : détail des épreuves
- `scores.html` : saisie des performances
- `classement.html` : classement général
- `ops.html` : tableau de bord opérationnel

## Divisions (Hyrox)

Aligné sur la [fiche officielle Hyrox France](https://hyroxfrance.com/fr/la-course/) : **Open**, **Pro**, **Double** (deux personnes), **mixte** (charges Open homme). Au club, le parcours reste une adaptation (6 zones).

## Déploiement GitHub Pages

1. Crée un dépôt GitHub et pousse le dossier `hyrox-epicure-manager`.
2. Dans GitHub : **Settings > Pages**.
3. Source : **Deploy from a branch**.
4. Branche : `main` (ou `master`), dossier `/ (root)`.
5. Ouvre l’URL GitHub Pages générée.

## Persistance cloud (Supabase)

Le site reste statique (GitHub Pages), avec stockage cloud (Supabase).

1. Crée un projet Supabase.
2. Crée la table SQL suivante :

```sql
create table if not exists public.competition_states (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
```

3. Vérifie que les policies RLS autorisent lecture/écriture avec la clé publishable.

## Paramètres

Dans la config (page admin), tu peux régler notamment :

- heure du 1er départ ;
- intervalle entre heats ;
- nombre d’athlètes par heat.

Le paramètre d’URL `?comp=…` identifie la compétition côté Supabase (défaut projet : `hyrox-epicure-2026`).

Les clés `localStorage` et la session admin sont préfixées `hyrox_` pour éviter les collisions avec d’autres outils sur le même navigateur.
