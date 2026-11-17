/** UI strings. Server renders in the request language (cookie `lang`, then Accept-Language). */
export const DICT = {
  en: {
    overview: "Overview", findings: "Findings", updates: "Updates", alerts: "Alerts", logs: "Logs", metrics: "Metrics",
    instances: "Instances", integrations: "Integrations", allInstances: "All instances",
    sentToday: "{n} notification(s) sent today", noneToday: "No notification sent today",
    weekLine: "Alerts this week: {sent} sent, {quiet} kept quiet ({pct}%)", viewAlerts: "View alerts",
    whatHappened: "What happened", last24h: "Last 24 hours", worthFixing: "What's worth fixing", nothingToFix: "Nothing needs fixing as of the last log review.",
    resources24h: "Resources · 24h", allMetrics: "All metrics", acrossN: "across {n} containers", cpu: "CPU", memory: "Memory",
    alertSent: "Alert sent", suppressed: "Kept quiet", muted: "Muted", resolved: "Resolved", events: "Events", noAlerts: "No alerts in this window.",
    findingsIntro: "What the log review judged worth fixing, across every instance. Findings stay open until the errors behind them stop.",
    nextReview: "Next review {when} · daily", needsAttention: "Needs attention", all: "All", ignored: "Ignored", noLlm: "The log review needs an LLM: set LLM_BASE_URL.",
    updatesIntro: "Every container image and configuration change, whether it was made in Dozzle or outside it.", noUpdates: "No change recorded yet.",
    alertsIntro: "What reached you, the raw events behind it, and what is muted.", noMutes: "Nothing is muted.",
    logsIntro: "Search container logs live through Dozzle.", search: "Search", query: "Text or regex", container: "Container", window: "Window",
    metricsIntro: "CPU, memory, network and disk for every container your instances report.", running: "Running", sortBy: "Sort by", peak: "peak", ofLimit: "of limit",
    hosts: "hosts", containers: "containers", online: "Online", offline: "Offline", instancesIntro: "Dozzle instances this server reports on.",
    integrationsIntro: "Where alerts get delivered and how AI clients connect.", mcpEndpoint: "MCP endpoint", notifyChannel: "Notification channel", none: "none",
    theme: "Theme", auto: "Auto", light: "Light", dark: "Dark", signOut: "Sign out", status: "Status", source: "Rule", level: "Level", when: "When",
    absorbed: "follow-up batches absorbed", eventsN: "{n} event(s)", daysOpen: "open {n} day(s)", why: "Why it matters", fix: "Suggested fix",
    searchAsk: "Search logs or ask…", showAll: "Show all {n}", stillHappening: "Still happening · day {n}",
    cpuNow: "CPU now", ofTotal: "{used} of {total}", newError: "new error", firstSeen: "First seen {when}",
    selfHosted: "SELF-HOSTED", brand: "Dozzle Cloud", notifications: "Notifications", chat: "Chat",
    muteNotif: "Mute notifications", notifChannels: "Notification channels", emailNotif: "Email notifications",
    dailyReport: "Daily report", connectedNow: "Connected now", filterContainers: "Filter containers",
    logsql: "LogsQL", volume: "Volume", method: "Method", message: "Message · path", duration: "Duration",
    changeTime: "Change time",
  },
  fr: {
    overview: "Vue d'ensemble", findings: "Constats", updates: "Mises à jour", alerts: "Alertes", logs: "Logs", metrics: "Métriques",
    instances: "Instances", integrations: "Intégrations", allInstances: "Toutes les instances",
    sentToday: "{n} notification(s) envoyée(s) aujourd'hui", noneToday: "Aucune notification envoyée aujourd'hui",
    weekLine: "Alertes cette semaine : {sent} envoyées, {quiet} gardées sous silence ({pct} %)", viewAlerts: "Voir les alertes",
    whatHappened: "Ce qui s'est passé", last24h: "Dernières 24 heures", worthFixing: "Ce qui mérite d'être corrigé", nothingToFix: "Rien à corriger d'après la dernière revue des logs.",
    resources24h: "Ressources · 24 h", allMetrics: "Toutes les métriques", acrossN: "sur {n} conteneurs", cpu: "CPU", memory: "Mémoire",
    alertSent: "Alerte envoyée", suppressed: "Gardée sous silence", muted: "En sourdine", resolved: "Résolu", events: "Événements", noAlerts: "Aucune alerte sur cette période.",
    findingsIntro: "Ce que la revue des logs a jugé utile de corriger, toutes instances confondues. Un constat reste ouvert tant que les erreurs continuent.",
    nextReview: "Prochaine revue {when} · quotidienne", needsAttention: "À traiter", all: "Tous", ignored: "Ignorés", noLlm: "La revue des logs exige un LLM : renseigner LLM_BASE_URL.",
    updatesIntro: "Chaque changement d'image ou de configuration, fait dans Dozzle ou en dehors.", noUpdates: "Aucun changement enregistré.",
    alertsIntro: "Ce qui vous est parvenu, les événements bruts derrière, et ce qui est en sourdine.", noMutes: "Rien n'est en sourdine.",
    logsIntro: "Chercher dans les logs des conteneurs, en direct via Dozzle.", search: "Chercher", query: "Texte ou regex", container: "Conteneur", window: "Fenêtre",
    metricsIntro: "CPU, mémoire, réseau et disque de chaque conteneur remonté par vos instances.", running: "En cours", sortBy: "Trier par", peak: "pic", ofLimit: "de la limite",
    hosts: "hôtes", containers: "conteneurs", online: "En ligne", offline: "Hors ligne", instancesIntro: "Instances Dozzle suivies par ce serveur.",
    integrationsIntro: "Où partent les alertes et comment les clients IA se branchent.", mcpEndpoint: "Point d'accès MCP", notifyChannel: "Canal de notification", none: "aucun",
    theme: "Thème", auto: "Auto", light: "Clair", dark: "Sombre", signOut: "Se déconnecter", status: "Statut", source: "Règle", level: "Niveau", when: "Quand",
    absorbed: "lots suivants absorbés", eventsN: "{n} événement(s)", daysOpen: "ouvert depuis {n} jour(s)", why: "Pourquoi c'est important", fix: "Correctif proposé",
    searchAsk: "Chercher dans les logs…", showAll: "Tout afficher ({n})", stillHappening: "Toujours en cours · jour {n}",
    cpuNow: "CPU maintenant", ofTotal: "{used} sur {total}", newError: "nouvelle erreur", firstSeen: "Vu d'abord le {when}",
    selfHosted: "SELF-HOSTED", brand: "Dozzle Cloud", notifications: "Notifications", chat: "Chat",
    muteNotif: "Mettre les notifications en sourdine", notifChannels: "Canaux de notification", emailNotif: "Notifications par e-mail",
    dailyReport: "Rapport quotidien", connectedNow: "Connecté", filterContainers: "Filtrer les conteneurs",
    logsql: "LogsQL", volume: "Volume", method: "Méthode", message: "Message · chemin", duration: "Durée",
    changeTime: "Changer l'heure",
  },
} as const;

export type Lang = keyof typeof DICT;
export type Key = keyof (typeof DICT)["en"];

export function pickLang(cookie: string | undefined, accept: string | undefined): Lang {
  const c = cookie?.match(/(?:^|;\s*)lang=(fr|en)/)?.[1];
  if (c) return c as Lang;
  return accept?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function t(lang: Lang, k: Key, vars: Record<string, string | number> = {}): string {
  return (DICT[lang][k] as string).replace(/\{(\w+)\}/g, (_, v) => String(vars[v] ?? ""));
}
