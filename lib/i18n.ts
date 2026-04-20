// Small helpers for bilingual UX. No heavy framework — flat dictionary + cookie.

export type Lang = "en" | "fr";

export const LANGS: readonly Lang[] = ["en", "fr"] as const;

export function normalizeLang(raw: string | null | undefined): Lang {
  if (!raw) return "en";
  const v = raw.toLowerCase().trim();
  if (v.startsWith("fr")) return "fr";
  return "en";
}

/**
 * Pick a UI language from request signals, with a strong English default.
 *
 *   cookie === "fr" or "en"  → always wins (explicit user choice)
 *   Accept-Language primary tag starts with "fr" AND no en-* variant is
 *     listed ahead of any fr-* tag with comparable weight  → "fr"
 *   anything else  → "en"
 *
 * We intentionally default to English unless the browser actually prefers
 * French. This prevents mixed-locale systems (e.g. fr-CA listed but en-CA
 * preferred) from flipping the site to French unexpectedly.
 */
export function pickLang(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined
): Lang {
  if (cookieValue === "fr" || cookieValue === "en") return cookieValue;

  if (!acceptLanguage) return "en";

  // Parse "fr-CA,fr;q=0.9,en-US;q=0.8,en;q=0.7" style headers into an ordered
  // list of [tag, q] pairs, highest quality first, stable on ties.
  const entries = acceptLanguage
    .split(",")
    .map((raw, idx) => {
      const [tagPart, ...params] = raw.trim().split(";");
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p);
        if (m) q = parseFloat(m[1]);
      }
      return { tag: tagPart.toLowerCase(), q, idx };
    })
    .filter((e) => e.tag && !Number.isNaN(e.q))
    .sort((a, b) => (b.q - a.q) || (a.idx - b.idx));

  for (const e of entries) {
    if (e.tag === "*") continue;
    if (e.tag.startsWith("fr")) return "fr";
    if (e.tag.startsWith("en")) return "en";
  }
  return "en";
}

type Dict = Record<Lang, string>;

const STRINGS: Record<string, Dict> = {
  "ask.title": { en: "Ask the Data", fr: "Interroger les données" },
  "ask.subtitle": {
    en: "Ask natural-language questions about 3.75M federal contracts, grants, and charity records. Follow-ups welcome.",
    fr: "Posez des questions en langage naturel sur 3,75 M de contrats, subventions et dossiers d'organismes de bienfaisance fédéraux. Suivis bienvenus.",
  },
  "ask.placeholder.first": {
    en: "Ask a question about government spending…",
    fr: "Posez une question sur les dépenses du gouvernement…",
  },
  "ask.placeholder.follow": {
    en: "Ask a follow-up (e.g. “break that down by year”)…",
    fr: "Posez un suivi (ex. « ventile cela par année »)…",
  },
  "ask.submit": { en: "Ask", fr: "Demander" },
  "ask.loading.short": { en: "…", fr: "…" },
  "ask.loading.understanding": {
    en: "Reading your question…",
    fr: "Lecture de votre question…",
  },
  "ask.loading.planning": {
    en: "Planning an approach…",
    fr: "Planification de l'approche…",
  },
  "ask.loading.writing": {
    en: "Writing the query…",
    fr: "Rédaction de la requête…",
  },
  "ask.loading.running": {
    en: "Running against 3.75M records…",
    fr: "Exécution sur 3,75 M de dossiers…",
  },
  "ask.loading.summarizing": {
    en: "Summarizing the answer…",
    fr: "Synthèse de la réponse…",
  },
  "ask.loading.checking": {
    en: "Double-checking for caveats…",
    fr: "Vérification des mises en garde…",
  },
  "ask.show_sql": { en: "Show SQL", fr: "Afficher le SQL" },
  "ask.hide_sql": { en: "Hide SQL", fr: "Masquer le SQL" },
  "ask.show_plan": { en: "Show plan", fr: "Afficher le plan" },
  "ask.hide_plan": { en: "Hide plan", fr: "Masquer le plan" },
  "ask.chart": { en: "Chart", fr: "Graphique" },
  "ask.table": { en: "Table", fr: "Tableau" },
  "ask.followups": { en: "Suggested follow-ups", fr: "Suivis suggérés" },
  "ask.selfcheck": { en: "I double-checked:", fr: "J'ai vérifié :" },
  "ask.row": { en: "row", fr: "ligne" },
  "ask.rows": { en: "rows", fr: "lignes" },
  "ask.back": { en: "← Back to dashboard", fr: "← Retour au tableau de bord" },
  "ask.clear": {
    en: "Start a new conversation",
    fr: "Nouvelle conversation",
  },
  "ask.examples": { en: "Try these:", fr: "Essayez :" },
  "ask.examples.investigate": { en: "Investigate", fr: "Enquêter" },
  "ask.examples.find_waste": { en: "Find waste", fr: "Trouver le gaspillage" },
  "ask.examples.track_outcomes": {
    en: "Track outcomes",
    fr: "Suivre les résultats",
  },
  "ask.mic.start": {
    en: "Start voice input",
    fr: "Démarrer la saisie vocale",
  },
  "ask.mic.stop": { en: "Stop voice input", fr: "Arrêter la saisie vocale" },
  "ask.mic.listening": { en: "Listening…", fr: "À l'écoute…" },
  "ask.mic.unsupported": {
    en: "Voice input isn't available in this browser.",
    fr: "La saisie vocale n'est pas disponible dans ce navigateur.",
  },
  "ask.speak": { en: "Read aloud", fr: "Lire à haute voix" },
  "ask.speak.stop": { en: "Stop reading", fr: "Arrêter la lecture" },
  "ask.error.generic": {
    en: "Something went wrong on our end. Try again?",
    fr: "Une erreur est survenue de notre côté. Réessayer ?",
  },
  "ask.error.rephrase": {
    en: "I couldn't run that query. You might try rephrasing.",
    fr: "Je n'ai pas pu exécuter cette requête. Essayez de reformuler.",
  },
  "ask.share.copy": { en: "Copy share link", fr: "Copier le lien" },
  "ask.share.copied": { en: "Link copied!", fr: "Lien copié !" },
  "ask.memo.button": {
    en: "Turn into a briefing memo",
    fr: "Transformer en note d'information",
  },
  "lang.toggle.en": { en: "English", fr: "Anglais" },
  "lang.toggle.fr": { en: "Français", fr: "Français" },
  "lang.toggle.aria": {
    en: "Switch language. Current: English.",
    fr: "Changer de langue. Actuelle : français.",
  },
  "briefing.title": {
    en: "Three things worth your attention today",
    fr: "Trois sujets à examiner aujourd'hui",
  },
  "briefing.subtitle": {
    en: "Overnight I scanned 3.75M federal records. Here's what I found:",
    fr: "Pendant la nuit, j'ai parcouru 3,75 M de dossiers fédéraux. Voici ce que j'ai trouvé :",
  },
  "briefing.investigate": { en: "Investigate this →", fr: "Enquêter →" },
  "briefing.loading": {
    en: "Preparing today's briefing…",
    fr: "Préparation de la note du jour…",
  },
  "briefing.unavailable": {
    en: "Briefing unavailable — try asking your own question below.",
    fr: "Note indisponible — posez votre propre question ci-dessous.",
  },
};

export function t(key: string, lang: Lang): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[lang] ?? entry.en ?? key;
}

/** Map our Lang to BCP-47 tags used by Web Speech / Azure Speech. */
export function speechLocale(lang: Lang): string {
  return lang === "fr" ? "fr-CA" : "en-CA";
}
