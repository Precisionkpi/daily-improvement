(function () {
  "use strict";

  // ---- Supabase client (config.js must define window.ODI_CONFIG) ----
  const cfg = window.ODI_CONFIG;
  const sb = (cfg && window.supabase && cfg.supabaseUrl && cfg.supabaseAnonKey)
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;

  if (!cfg || !sb) {
    document.body.innerHTML =
      '<div style="max-width:520px;margin:60px auto;padding:28px;font-family:system-ui,sans-serif;text-align:center;color:#333;border:1px solid #ddd;border-radius:12px;">' +
      '<h2 style="margin:0 0 10px;">Setup needed</h2>' +
      '<p>Copy <code>config.example.js</code> to <code>config.js</code> and fill in your Supabase URL and anon key.</p>' +
      '<p>See <code>README.md</code> for the full setup.</p></div>';
    return;
  }

  const PHOTOS_BUCKET = cfg.photosBucket || "entry-photos";
  const FN_BASE = `${cfg.supabaseUrl}/functions/v1`;
  const FN = {
    headline:  `${FN_BASE}/generate-headline`,
    structure: `${FN_BASE}/structure-entry`,
    translate: `${FN_BASE}/translate-entry`,
    weekly:    `${FN_BASE}/weekly-digest`,
    nudge:     `${FN_BASE}/stale-nudge`,
    monthly:   `${FN_BASE}/monthly-report`,
  };

  function fnCall(url, body, { background = false } = {}) {
    const p = fetch(url, {
      method: "POST",
      headers: {
        "apikey": cfg.supabaseAnonKey,
        "Authorization": `Bearer ${cfg.supabaseAnonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    if (background) {
      p.catch((err) => { console.warn("edge fn failed", url, err); });
      return p;
    }
    return p.then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json();
    });
  }

  // Background: Claude generates headline + category + kind + related_to on save.
  // The realtime subscription picks up the write and re-renders.
  function kickHeadlineGeneration(entry) {
    if (!entry || !entry.id || !entry.problem) return;
    const body = { submission_id: entry.id, problem: entry.problem };
    if (entry.solution) body.solution = entry.solution;
    if (entry.impact)   body.impact   = entry.impact;
    fnCall(FN.headline, body, { background: true });
  }

  // Web Speech API recognition — browser-side transcription, free, no key.
  // On stop, we send the transcript through structure-entry so Claude splits it
  // into problem / solution / impact and fills in the form.
  function wireVoiceButton() {
    const btn = document.getElementById("voice-btn");
    const status = document.getElementById("voice-status");
    if (!btn) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btn.disabled = true;
      btn.title = "Voice-to-text not supported in this browser. Try Chrome or Safari.";
      btn.classList.add("voice-btn-unavail");
      return;
    }
    let recog = null, listening = false, fullTranscript = "";
    let processed = false, safetyTimer = null;

    function setStatus(text, cls) {
      if (!status) return;
      status.hidden = !text;
      status.textContent = text || "";
      status.className = "voice-status" + (cls ? " " + cls : "");
    }

    function uiToIdle() {
      listening = false;
      btn.classList.remove("is-recording");
      const label = btn.querySelector(".voice-label");
      if (label) label.textContent = "Speak";
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    }
    function uiToRecording() {
      listening = true;
      btn.classList.add("is-recording");
      const label = btn.querySelector(".voice-label");
      if (label) label.textContent = "Stop";
    }

    async function structureAndFill(transcript) {
      if (processed) return;
      processed = true;
      setStatus("Claude is writing it up…", "working");
      btn.disabled = true;
      try {
        const out = await fnCall(FN.structure, { transcript });
        const p = document.getElementById("f-problem");
        const s = document.getElementById("f-solution");
        const i = document.getElementById("f-impact");
        if (p && out.problem) p.value = out.problem;
        if (s && out.solution) s.value = out.solution;
        if (i && out.impact) i.value = out.impact;
        if (out.kind && out.kind !== STATE.submitKind) {
          STATE.submitKind = out.kind;
          document.querySelectorAll("#submit-form .kind-opt").forEach((b) => {
            b.setAttribute("aria-pressed", String(b.dataset.kind === STATE.submitKind));
          });
        }
        setStatus("Filled in — review and tweak before submitting.", "done");
        setTimeout(() => setStatus(""), 4000);
      } catch (err) {
        console.warn("structure failed", err);
        // Fallback: drop the raw transcript into the problem field.
        const p = document.getElementById("f-problem");
        if (p) p.value = transcript;
        setStatus("Couldn't auto-structure — put the raw transcript in. Edit it before submitting.", "err");
        setTimeout(() => setStatus(""), 6000);
      } finally {
        btn.disabled = false;
      }
    }

    function finish(reason) {
      // Called from click-stop, onend, or the safety timer. Idempotent.
      if (!listening && processed) return;
      uiToIdle();
      const t = fullTranscript.trim();
      if (t.length < 3) {
        processed = true; // prevent any lingering onend from processing empty
        setStatus(
          reason === "timeout"
            ? "Stopped after 60s — tap Speak again if you want another go."
            : "Didn't catch anything — tap Speak and talk a bit louder.",
          "err"
        );
        setTimeout(() => setStatus(""), 4000);
        return;
      }
      structureAndFill(t);
    }

    function start() {
      if (listening) return;
      fullTranscript = "";
      processed = false;
      try {
        recog = new SR();
        recog.lang = (STATE.lang === "es") ? "es-US" : "en-US";
        recog.interimResults = true;
        recog.continuous = true;
      } catch (e) {
        setStatus("Mic unavailable in this browser.", "err");
        return;
      }
      recog.onresult = (e) => {
        let finalChunk = "", interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalChunk += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (finalChunk) fullTranscript += finalChunk + " ";
        setStatus(`Listening… "${(fullTranscript + interim).trim().slice(-120)}"`, "working");
      };
      recog.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") return;
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setStatus("Mic permission denied — tap the lock icon in your browser bar to allow.", "err");
          uiToIdle();
          return;
        }
        setStatus(`Mic error: ${e.error} — tap Speak to try again.`, "err");
        uiToIdle();
      };
      recog.onend = () => {
        // Browser auto-ended (e.g. silence). Process whatever we got.
        if (processed) return;
        finish("auto");
      };
      try {
        recog.start();
        uiToRecording();
        setStatus("Listening — tap Stop when you're done.", "working");
        // Safety: auto-stop after 60s so a forgotten tap doesn't keep the mic hot.
        safetyTimer = setTimeout(() => {
          try { if (recog) recog.stop(); } catch (_e) {}
          finish("timeout");
        }, 60000);
      } catch (e) {
        setStatus("Couldn't start mic — check permissions and try again.", "err");
        uiToIdle();
      }
    }

    function stop() {
      // Immediately reset the UI so the button is never visually stuck.
      if (!listening) return;
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      // Try to stop the recognizer; also abort in case stop() is slow or ignored.
      if (recog) {
        try { recog.stop();  } catch (_e) {}
        try { recog.abort(); } catch (_e) {}
      }
      finish("user");
    }

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (listening) stop();
      else start();
    });
  }

  const NAMES = [
    "Ben Newbold",
    "Jesse Hill",
    "Geo Martinez",
    "Sergio Pasasin",
    "Stephanie McLarty",
    "Emily Leitzel",
    "Kristina Gadiaga",
    "Nico Gianni",
  ];
  const CATEGORIES = [
    { code: "equipment",  label: "Equipment",  emoji: "🔧" },
    { code: "scheduling", label: "Scheduling", emoji: "📅" },
    { code: "materials",  label: "Materials",  emoji: "📦" },
    { code: "customer",   label: "Customer",   emoji: "👥" },
    { code: "sales",      label: "Sales",      emoji: "💰" },
    { code: "safety",     label: "Safety",     emoji: "⚠️" },
    { code: "process",    label: "Process",    emoji: "🔄" },
    { code: "training",   label: "Training",   emoji: "🎓" },
    { code: "other",      label: "Other",      emoji: "🔖" },
  ];
  function categoryByCode(code) {
    return CATEGORIES.find((c) => c.code === code) || CATEGORIES[CATEGORIES.length - 1];
  }
  const MAX_PHOTOS_PER_FIELD = 4;
  const REACTIONS = [
    { code: "like", char: "👍" },
    { code: "fire", char: "🔥" },
    { code: "idea", char: "💡" },
    { code: "clap", char: "👏" },
    { code: "love", char: "❤️" },
  ];

  const STATE = {
    db: null,
    user: null,
    assets: null,
    isOwner: false,
    canWrite: null,
    submissions: [],
    reactions: [],
    comments: [],
    updates: [],
    loading: true,
    loadError: null,
    activeTab: "submit",
    filter: "all",
    name: readStoredName(),
    pending: false,
    formPhotos: { problem: [], solution: [] },
    submitKind: "difficult",
    submitStatus: "assigned",
    submitCategory: "other",
    submitAssignees: ["", ""],
    openCommentThread: null,
    seenEntryIds: new Set(),
    bootedAt: Date.now(),
    notifEnabled: readStoredNotif(),
    scoreRange: "week",
    lang: readStoredLang(),
    translations: {},
    insights: { weekly: null, monthly: null, loading: false },
  };

  function readStoredName() {
    try {
      const n = localStorage.getItem("don:name") || "";
      return NAMES.includes(n) ? n : "";
    } catch { return ""; }
  }
  function saveStoredName(n) { try { localStorage.setItem("don:name", n); } catch {} }
  function readStoredNotif() {
    try { return localStorage.getItem("don:notif") === "1"; } catch { return false; }
  }
  function readStoredLang() {
    try {
      const v = localStorage.getItem("don:lang");
      return v === "es" ? "es" : "en";
    } catch { return "en"; }
  }
  function saveStoredLang(l) { try { localStorage.setItem("don:lang", l); } catch {} }

  // UI string dictionary. Entries themselves (problem/solution/impact/headline)
  // translate via the submissions.translations JSONB column. This dict only
  // covers the chrome: tabs, labels, buttons, section headers.
  const T = {
    en: {
      tabSubmit: "Submit", tabMine: "Mine", tabInbox: "Inbox",
      tabFeed: "Feed", tabScoreboard: "Scoreboard",
      statWeek: "This week", statProgress: "In progress", statImproved: "Improved",
      inboxUnread: "Unread", inboxAll: "All",
      inboxMarkAllRead: "Mark all read",
      inboxFor: "Inbox for",
      inboxBack: "← Back to inbox",
      inboxMoveBack: "↩ Move back to inbox",
      inboxEmpty: "Nothing in your inbox",
      inboxEmptyDesc: "You'll see comments, Claude's check-ins, and new entries from the crew here.",
      inboxEmptyUnread: "You're caught up ✨",
      inboxEmptyRead: "Nothing to show.",
      kindClaudeCheckin: "Claude check-in", kindNewComment: "New comment",
      kindStatusUpdate: "Status update", kindMarkedImproved: "Marked improved",
      kindWeeklyDigest: "Weekly digest",
      kindNewProblem: "New problem logged", kindNewImpact: "New impact logged",
      roleYourEntry: "Your entry", roleAssigned: "Assigned to you",
      roleFromTeam: "From the team", roleForCrew: "For the whole crew · tap to open in Scoreboard",
      markedImprovedBy: "marked this improved",
      posted: "posted",
      entryLabelProblem: "The problem", entryLabelMove: "The move",
      entryLabelImpact: "IMPACT", entryLabelSolution: "SOLUTION",
      entryLabelPotential: "POTENTIAL SOLUTION", entryLabelWhyMatters: "WHY IT MATTERS",
      entryLabelSubmittedBy: "Submitted By:", entryLabelAssignedTo: "Assigned To",
      insightsWeek: "✨ This week at a glance",
      insightsMonth: "📋",
      insightsRefresh: "Refresh",
      insightsWins: "Wins this week", insightsOpen: "Still open — worth attention",
      insightsPatterns: "Patterns to watch",
      insightsImprovements: "Improvements shipped", insightsThemes: "Themes",
      insightsGenerate: "Generate weekly digest",
      insightsLoading: "Claude is reading this week's entries…",
      welcomePrompt: "Who's logging in?",
      welcomeSub: "Pick your name to get started.",
      welcomeFooter: "One improvement a day — the climb never ends.",
      workload: "Workload", workloadSub: "right now · tap to filter",
      workloadOpen: "open",
      sectionInProgress: "In progress",
      noInstructions: "No instructions yet.",
    },
    es: {
      tabSubmit: "Enviar", tabMine: "Míos", tabInbox: "Buzón",
      tabFeed: "Actividad", tabScoreboard: "Marcador",
      statWeek: "Esta semana", statProgress: "En progreso", statImproved: "Mejorado",
      inboxUnread: "Sin leer", inboxAll: "Todos",
      inboxMarkAllRead: "Marcar todo leído",
      inboxFor: "Buzón de",
      inboxBack: "← Volver al buzón",
      inboxMoveBack: "↩ Volver al buzón",
      inboxEmpty: "Nada en tu buzón",
      inboxEmptyDesc: "Aquí verás comentarios, mensajes de Claude y entradas nuevas del equipo.",
      inboxEmptyUnread: "Estás al día ✨",
      inboxEmptyRead: "Nada que mostrar.",
      kindClaudeCheckin: "Mensaje de Claude", kindNewComment: "Comentario nuevo",
      kindStatusUpdate: "Cambio de estado", kindMarkedImproved: "Marcado mejorado",
      kindWeeklyDigest: "Resumen semanal",
      kindNewProblem: "Nuevo problema", kindNewImpact: "Nueva mejora",
      roleYourEntry: "Tu entrada", roleAssigned: "Asignado a ti",
      roleFromTeam: "Del equipo", roleForCrew: "Para todo el equipo · toca para ver en Marcador",
      markedImprovedBy: "marcó esto como mejorado",
      posted: "publicó",
      entryLabelProblem: "El problema", entryLabelMove: "La mejora",
      entryLabelImpact: "IMPACTO", entryLabelSolution: "SOLUCIÓN",
      entryLabelPotential: "POSIBLE SOLUCIÓN", entryLabelWhyMatters: "POR QUÉ IMPORTA",
      entryLabelSubmittedBy: "Enviado por:", entryLabelAssignedTo: "Asignado a",
      insightsWeek: "✨ Esta semana de un vistazo",
      insightsMonth: "📋",
      insightsRefresh: "Actualizar",
      insightsWins: "Logros de la semana", insightsOpen: "Pendientes — vale la pena atender",
      insightsPatterns: "Patrones a vigilar",
      insightsImprovements: "Mejoras logradas", insightsThemes: "Temas",
      insightsGenerate: "Generar resumen semanal",
      insightsLoading: "Claude está leyendo las entradas de esta semana…",
      welcomePrompt: "¿Quién está iniciando sesión?",
      welcomeSub: "Elige tu nombre para empezar.",
      welcomeFooter: "Una mejora al día — el ascenso no termina.",
      workload: "Carga", workloadSub: "ahora mismo · toca para filtrar",
      workloadOpen: "abiertos",
      sectionInProgress: "En progreso",
      noInstructions: "Sin instrucciones todavía.",
    },
  };
  function t(key) {
    const lang = STATE.lang || "en";
    return (T[lang] && T[lang][key]) || T.en[key] || key;
  }
  function saveNotif(v) { try { localStorage.setItem("don:notif", v ? "1" : "0"); } catch {} }

  async function boot() {
    STATE.db = sb;
    STATE.assets = sb.storage;
    STATE.isOwner = !!(STATE.name && cfg.owner && STATE.name === cfg.owner);
    STATE.canWrite = true;

    renderWelcomeScreen();
    render();
    wireTabs();

    wireLangToggle();
    await loadAll();
    subscribeRealtime();
    // Kick off background AI chores (no blocking) + pre-fetch the digests so
    // the inbox can show them without an extra wait when the user opens it.
    // The prefetch delegates to ensureDigestsLoaded so the current-week
    // fallback-to-last-week logic runs here too; otherwise this prefetch
    // would overwrite the good fallback with the empty current-week digest.
    setTimeout(() => {
      fnCall(FN.nudge, {}, { background: true });
      ensureDigestsLoaded();
    }, 2500);
  }

  function renderWelcomeScreen() {
    const host = document.getElementById("welcome-names");
    const screen = document.getElementById("welcome-screen");
    if (!host || !screen) return;
    host.innerHTML = NAMES.map((n) => `<button type="button" class="welcome-name-btn" data-welcomepick="${esc(n)}">${esc(n)}</button>`).join("");
    host.querySelectorAll("[data-welcomepick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.name = btn.dataset.welcomepick;
        saveStoredName(STATE.name);
        STATE.isOwner = !!(cfg && cfg.owner && STATE.name === cfg.owner);
        syncWelcomeVisibility();
        render();
      });
    });
    syncWelcomeVisibility();
  }
  function syncWelcomeVisibility() {
    const screen = document.getElementById("welcome-screen");
    const app = document.querySelector(".app");
    if (!screen || !app) return;
    if (!STATE.name) {
      screen.hidden = false;
      app.style.display = "none";
    } else {
      screen.hidden = true;
      app.style.display = "";
    }
  }

  // ---- DB <-> app shape converters (snake_case columns in Postgres) ----
  function subFromDb(r) {
    return {
      id: r.id,
      name: r.name,
      headline: r.headline,
      problem: r.problem,
      solution: r.solution,
      impact: r.impact,
      problemPhotos: r.problem_photos || [],
      solutionPhotos: r.solution_photos || [],
      status: r.status,
      kind: r.kind,
      category: r.category,
      assignedTo: r.assigned_to,
      assignees: r.assignees,
      assignedBy: r.assigned_by,
      assignedAt: r.assigned_at,
      assignmentNote: r.assignment_note,
      improvedBy: r.improved_by,
      improvedAt: r.improved_at,
      improvedNote: r.improved_note,
      checklist: Array.isArray(r.checklist) ? r.checklist : [],
      relatedTo: Array.isArray(r.related_to) ? r.related_to : [],
      sourceLang: r.source_lang || null,
      translations: (r.translations && typeof r.translations === "object") ? r.translations : null,
      createdAt: r.created_at,
    };
  }

  // Return the entry's text in the viewer's preferred language, falling back
  // to the stored column if we don't have a translation yet. One helper here
  // so every render path stays in sync with the EN/ES toggle.
  function localized(entry, field) {
    const lang = STATE.lang || "en";
    const t = entry?.translations?.[lang];
    const v = t ? t[field] : null;
    if (typeof v === "string" && v.trim()) return v;
    return entry?.[field] ?? "";
  }
  function reactionFromDb(r) {
    return { id: r.id, entryId: r.entry_id, user: r.username, code: r.code, createdAt: r.created_at };
  }
  function commentFromDb(r) {
    return { id: r.id, entryId: r.entry_id, author: r.author, text: r.text, createdAt: r.created_at };
  }
  function updateFromDb(r) {
    return { id: r.id, entryId: r.entry_id, author: r.author, text: r.text, createdAt: r.created_at };
  }

  async function loadAll() {
    const timer = setTimeout(() => {
      if (STATE.loading) { STATE.loading = false; STATE.loadError = "slow"; render(); }
    }, 10000);
    try {
      const [subs, reacts, comms, ups] = await Promise.all([
        sb.from("submissions").select("*").order("created_at", { ascending: false }),
        sb.from("reactions").select("*"),
        sb.from("comments").select("*").order("created_at", { ascending: true }),
        sb.from("updates").select("*").order("created_at", { ascending: true }),
      ]);
      clearTimeout(timer);
      if (subs.error) throw subs.error;
      if (reacts.error) throw reacts.error;
      if (comms.error) throw comms.error;
      if (ups.error) throw ups.error;
      STATE.submissions = (subs.data || []).map(subFromDb);
      STATE.reactions = (reacts.data || []).map(reactionFromDb);
      STATE.comments = (comms.data || []).map(commentFromDb);
      STATE.updates = (ups.data || []).map(updateFromDb);
      STATE.seenEntryIds = new Set(STATE.submissions.map((s) => s.id));
      STATE.loading = false;
      STATE.loadError = null;
      render({ fromSnapshot: true });
    } catch (e) {
      clearTimeout(timer);
      console.error("loadAll failed", e);
      STATE.loading = false;
      STATE.loadError = e?.code || e?.message || "error";
      render();
    }
  }

  async function refreshSubmissions() {
    const { data, error } = await sb.from("submissions").select("*").order("created_at", { ascending: false });
    if (error) { console.error("refreshSubmissions", error); return; }
    const prevIds = STATE.seenEntryIds;
    const newItems = (data || []).map(subFromDb);
    for (const s of newItems) {
      if (!prevIds.has(s.id) && s.name && s.name !== STATE.name && s.createdAt) {
        const age = Date.now() - new Date(s.createdAt).getTime();
        if (age < 90000) { cheerToast(s); fireNotification(s); }
      }
    }
    STATE.submissions = newItems;
    STATE.seenEntryIds = new Set(newItems.map((s) => s.id));
    render({ fromSnapshot: true });
  }
  async function refreshReactions() {
    const { data, error } = await sb.from("reactions").select("*");
    if (error) { console.error("refreshReactions", error); return; }
    STATE.reactions = (data || []).map(reactionFromDb);
    render({ fromSnapshot: true });
  }
  async function refreshComments() {
    const { data, error } = await sb.from("comments").select("*").order("created_at", { ascending: true });
    if (error) { console.error("refreshComments", error); return; }
    STATE.comments = (data || []).map(commentFromDb);
    render({ fromSnapshot: true });
  }
  async function refreshUpdates() {
    const { data, error } = await sb.from("updates").select("*").order("created_at", { ascending: true });
    if (error) { console.error("refreshUpdates", error); return; }
    STATE.updates = (data || []).map(updateFromDb);
    render({ fromSnapshot: true });
  }

  function subscribeRealtime() {
    sb.channel("odi-stream")
      .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, () => refreshSubmissions())
      .on("postgres_changes", { event: "*", schema: "public", table: "reactions"   }, () => refreshReactions())
      .on("postgres_changes", { event: "*", schema: "public", table: "comments"    }, () => refreshComments())
      .on("postgres_changes", { event: "*", schema: "public", table: "updates"     }, () => refreshUpdates())
      .subscribe();
  }

  function cheerToast(s) {
    const el = document.createElement("div");
    el.className = "toast toast-cheer";
    el.textContent = "✨ " + (s.name) + " just posted — check it out";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ---- Notifications ----
  function wireNotifBtn() {
    const btn = document.getElementById("notif-btn");
    if (!btn) return;
    updateNotifBtn();
    btn.addEventListener("click", toggleNotif);
  }
  function updateNotifBtn() {
    const btn = document.getElementById("notif-btn");
    if (!btn) return;
    if (!("Notification" in window)) {
      btn.textContent = "🔕";
      btn.title = "Not supported in this browser";
      return;
    }
    const on = STATE.notifEnabled && Notification.permission === "granted";
    btn.classList.toggle("is-on", on);
    btn.textContent = on ? "🔔 Alerts on" : "🔔";
    btn.title = on ? "Alerts are on — tap to turn off" : "Tap to get notified about new entries";
  }
  async function toggleNotif() {
    if (!("Notification" in window)) { showToast("Not supported in this browser."); return; }
    if (Notification.permission === "denied") {
      showToast("Alerts blocked — turn on in browser settings.");
      return;
    }
    if (Notification.permission === "default") {
      try {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          STATE.notifEnabled = true;
          saveNotif(true);
          showToast("Alerts on 🔔");
          try { new Notification("One Daily Improvement", { body: "You'll see a popup here when someone posts." }); } catch {}
        } else {
          showToast("No alerts without permission.");
        }
      } catch (e) {
        console.error("notif perm failed", e);
        showToast("Alerts aren't available in this view.");
      }
      updateNotifBtn();
      return;
    }
    STATE.notifEnabled = !STATE.notifEnabled;
    saveNotif(STATE.notifEnabled);
    showToast(STATE.notifEnabled ? "Alerts on 🔔" : "Alerts off");
    updateNotifBtn();
  }
  function fireNotification(entry) {
    if (!("Notification" in window)) return;
    if (!STATE.notifEnabled) return;
    if (Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    try {
      new Notification(`${entry.name} posted`, {
        body: (entry.problem || "").slice(0, 160),
        tag: "odi-" + entry.id,
      });
    } catch (e) { console.error("notif failed", e); }
  }

  // ---- Rendering ----
  function render(opts) {
    opts = opts || {};
    renderStats();

    if (STATE.activeTab === "submit") {
      // Skip rebuild if form already there and this is a background snapshot
      if (opts.fromSnapshot && document.getElementById("submit-form")) return;
      renderSubmit();
      return;
    }

    const draft = captureCommentDraft();
    if (STATE.activeTab === "mine") renderMine();
    else if (STATE.activeTab === "assignments") renderAssignments();
    else if (STATE.activeTab === "inbox") renderInbox();
    else renderEveryone();
    if (draft) restoreCommentDraft(draft);
    paintInboxBadge();
    // If a detail modal is open, refresh its body so a new comment / reaction
    // / status change shows up without the user closing + reopening it.
    if (typeof STATE._detailModalRerender === "function") {
      STATE._detailModalRerender();
    }
  }

  function captureCommentDraft() {
    const inputs = document.querySelectorAll(".comment-composer input");
    for (const inp of inputs) {
      if (document.activeElement === inp || inp.value) {
        const form = inp.closest(".comment-composer");
        return {
          entryId: form.dataset.commentfor,
          value: inp.value,
          focused: document.activeElement === inp,
        };
      }
    }
    return null;
  }
  function restoreCommentDraft(draft) {
    const input = document.querySelector(`.comment-composer[data-commentfor="${draft.entryId}"] input`);
    if (input) {
      input.value = draft.value;
      if (draft.focused) {
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
      }
    }
  }

  function renderStats() {
    const subs = STATE.submissions;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekCount = subs.filter((s) => s.createdAt && new Date(s.createdAt) >= weekAgo).length;
    const inProgressCount = subs.filter((s) => s.status !== "improved").length;
    const improvedCount = subs.filter((s) => s.status === "improved").length;
    document.getElementById("stat-week").textContent = STATE.loading ? "—" : weekCount;
    document.getElementById("stat-progress").textContent = STATE.loading ? "—" : inProgressCount;
    document.getElementById("stat-improved").textContent = STATE.loading ? "—" : improvedCount;
  }

  function wireTabs() {
    syncTabUI();
    document.querySelectorAll("#tabs .tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.tab;
        if (STATE.activeTab === t) return;
        STATE.activeTab = t;
        syncTabUI();
        render();
      });
    });
    // Clickable stat cards jump to Feed with a matching filter.
    document.querySelectorAll("[data-statfilter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.activeTab = "everyone";
        STATE.filter = btn.dataset.statfilter;
        syncTabUI();
        render();
        const panel = document.getElementById("panel-everyone");
        if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }
  function syncTabUI() {
    const t = STATE.activeTab;
    document.querySelectorAll("#tabs .tab").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.tab === t));
    });
    document.getElementById("panel-mine").hidden = t !== "mine";
    document.getElementById("panel-submit").hidden = t !== "submit";
    document.getElementById("panel-inbox").hidden = t !== "inbox";
    document.getElementById("panel-assignments").hidden = t !== "assignments";
    document.getElementById("panel-everyone").hidden = t !== "everyone";
  }

  function renderSubmit() {
    const panel = document.getElementById("panel-submit");

    if (!STATE.db) {
      panel.innerHTML = `
        <div class="notice">
          <strong>Sign in to submit</strong>
          <p>Ask Ben to share this link with your email so you can log an entry.</p>
        </div>`;
      return;
    }

    const greet = STATE.name
      ? `<div class="greeting"><span>Logging as <strong>${esc(STATE.name)}</strong>${STATE.isOwner ? ' <span class="you-are">Owner</span>' : ''}</span><button class="link-btn" id="change-name">Not you?</button></div>`
      : "";

    const nameSelectHtml = STATE.name ? "" : `
      <div class="field">
        <label for="f-name">Your name</label>
        <select id="f-name" name="name" required>
          <option value="" disabled selected>— choose your name —</option>
          ${NAMES.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}
        </select>
      </div>`;

    // Default first assignee to the submitter when the form has no explicit picks yet.
    if (STATE.name && !STATE.submitAssignees[0] && !STATE.submitAssignees[1]) {
      STATE.submitAssignees = [STATE.name, ""];
    }
    const isImpact = STATE.submitKind === "impact";
    const problemLabel = isImpact
      ? "What's one thing you did (or we should do) to make an impact?"
      : "What made your day or the crew's day difficult?";
    const problemHint = isImpact
      ? "A win worth sharing, or an idea worth raising. Keep it short."
      : "One thing, in your own words. Keep it short.";
    const problemPlaceholder = isImpact
      ? "e.g. Reshuffled Monday route — saves 40 min/day of windshield time"
      : "e.g. Had to drive back to the shop twice for the wrong trimmer line";
    const solutionLabel = isImpact ? "Why it matters" : "Potential Solution / Solution";
    const solutionPlaceholder = isImpact
      ? "e.g. Less fuel burn, crews home earlier, happier customers"
      : "e.g. Keep an extra spool of each line size on every truck";

    panel.innerHTML = `
      ${greet}
      <form class="card form" id="submit-form" autocomplete="off">
        ${nameSelectHtml}
        <div class="field">
          <label>What kind of thing?</label>
          <div class="kind-choice" role="radiogroup" aria-label="Kind">
            <button type="button" class="kind-opt" data-kind="difficult" aria-pressed="${STATE.submitKind === 'difficult'}"><span class="emoji">🪓</span> Something difficult</button>
            <button type="button" class="kind-opt" data-kind="impact" aria-pressed="${STATE.submitKind === 'impact'}"><span class="emoji">💡</span> Impact move</button>
          </div>
        </div>
        <div class="field">
          <div class="field-head">
            <label for="f-problem">${problemLabel}</label>
            <button type="button" class="voice-btn" id="voice-btn" aria-label="Speak instead of typing" title="Hold to talk, release to transcribe">
              <span class="voice-icon">🎤</span><span class="voice-label">Speak</span>
            </button>
          </div>
          <span class="hint">${problemHint}</span>
          <div class="voice-status" id="voice-status" hidden></div>
          <textarea id="f-problem" name="problem" required maxlength="800" placeholder="${esc(problemPlaceholder)}"></textarea>
          <div class="photos" id="photos-problem" data-field="problem"></div>
        </div>
        <div class="field">
          <label for="f-impact">Impact <span class="optional">(optional — what it costs us if we don't address it)</span></label>
          <textarea id="f-impact" name="impact" maxlength="400" placeholder="e.g. Crew loses 20 min each morning · customer visits pushed back"></textarea>
        </div>
        <div class="field">
          <label for="f-solution">${solutionLabel} <span class="optional">(optional)</span></label>
          <textarea id="f-solution" name="solution" maxlength="800" placeholder="${esc(solutionPlaceholder)}"></textarea>
          <div class="photos" id="photos-solution" data-field="solution"></div>
        </div>
        <div class="field">
          <label>Status</label>
          <div class="status-choice" role="radiogroup" aria-label="Status">
            <button type="button" class="status-opt" data-status="assigned" aria-pressed="${STATE.submitStatus === 'assigned'}">In progress</button>
            <button type="button" class="status-opt" data-status="improved" aria-pressed="${STATE.submitStatus === 'improved'}">${isImpact ? 'Completed' : 'Solved'}</button>
          </div>
        </div>
        <div class="field" id="assign-field">
          <label>Assign to <span class="optional">(optional — picks "In progress" automatically)</span></label>
          <select id="f-assign-a" name="assignA">
            ${NAMES.map((n) => `<option value="${esc(n)}" ${n === STATE.submitAssignees[0] ? "selected" : ""}>${esc(n)}</option>`).join("")}
          </select>
          <select id="f-assign-b" name="assignB" style="margin-top:6px;">
            <option value="">— and a second person (optional) —</option>
            ${NAMES.map((n) => `<option value="${esc(n)}" ${n === STATE.submitAssignees[1] ? "selected" : ""}>${esc(n)}</option>`).join("")}
          </select>
        </div>
        <button type="submit" class="btn" id="submit-btn">${submitButtonLabel()}</button>
      </form>
    `;

    renderFormPhotos();

    document.getElementById("submit-form").addEventListener("submit", onSubmit);
    const changeBtn = document.getElementById("change-name");
    if (changeBtn) changeBtn.addEventListener("click", () => {
      STATE.name = "";
      saveStoredName("");
      syncWelcomeVisibility();
      render();
    });

    document.querySelectorAll("#submit-form .status-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.submitStatus = btn.dataset.status;
        document.querySelectorAll("#submit-form .status-opt").forEach((b) => {
          b.setAttribute("aria-pressed", String(b.dataset.status === STATE.submitStatus));
        });
        const sbtn = document.getElementById("submit-btn");
        if (sbtn) sbtn.textContent = submitButtonLabel();
      });
    });

    document.querySelectorAll("#submit-form .kind-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (STATE.submitKind === btn.dataset.kind) return;
        STATE.submitKind = btn.dataset.kind;
        // Preserve typed text when re-rendering
        const p = document.getElementById("f-problem");
        const s = document.getElementById("f-solution");
        const problemDraft = p ? p.value : "";
        const solutionDraft = s ? s.value : "";
        renderSubmit();
        const p2 = document.getElementById("f-problem");
        const s2 = document.getElementById("f-solution");
        if (p2) p2.value = problemDraft;
        if (s2) s2.value = solutionDraft;
      });
    });

    wireVoiceButton();

    const aSel = document.getElementById("f-assign-a");
    const bSel = document.getElementById("f-assign-b");
    const onAssignChange = () => {
      STATE.submitAssignees = [aSel.value || "", bSel.value || ""];
      // If any assignee set and status is still open, flip to "In progress"
      const anyAssigned = aSel.value || bSel.value;
      if (anyAssigned && STATE.submitStatus === "open") {
        STATE.submitStatus = "assigned";
        document.querySelectorAll("#submit-form .status-opt").forEach((b) => {
          b.setAttribute("aria-pressed", String(b.dataset.status === "assigned"));
        });
        const sbtn = document.getElementById("submit-btn");
        if (sbtn) sbtn.textContent = submitButtonLabel();
      }
    };
    if (aSel) aSel.addEventListener("change", onAssignChange);
    if (bSel) bSel.addEventListener("change", onAssignChange);
  }

  function submitButtonLabel() {
    const isImpact = STATE.submitKind === "impact";
    if (STATE.submitStatus === "improved") return isImpact ? "Log — completed ✓" : "Log — already solved";
    return isImpact ? "Log — working on it" : "Log — I'm working on it";
  }

  function renderFormPhotos() {
    for (const field of ["problem", "solution"]) {
      const host = document.getElementById("photos-" + field);
      if (!host) continue;
      const photos = STATE.formPhotos[field];
      const thumbs = photos.map((p, i) => `
        <div class="photo-thumb ${p.uploading ? "uploading" : ""}" style="background-image:url('${esc(p.url || "")}')" data-field="${field}" data-idx="${i}">
          ${!p.uploading ? `<button type="button" class="remove" data-remove="${field}:${i}" aria-label="Remove">×</button>` : ""}
        </div>`).join("");
      const addBtn = photos.length < MAX_PHOTOS_PER_FIELD
        ? `<button type="button" class="add-photo" data-add="${field}"><span class="plus">+</span><span>Photo</span></button>`
        : "";
      host.innerHTML = thumbs + addBtn;
    }
    document.querySelectorAll("[data-add]").forEach((btn) => {
      btn.addEventListener("click", () => pickPhoto(btn.dataset.add));
    });
    document.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [field, idx] = btn.dataset.remove.split(":");
        STATE.formPhotos[field].splice(Number(idx), 1);
        renderFormPhotos();
      });
    });
  }

  function pickPhoto(field) {
    if (!STATE.assets) { showToast("Photos aren't available for this view."); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { showToast("Photo is too big (max 20 MB)."); return; }
      const pending = { uploading: true, url: "", id: "" };
      STATE.formPhotos[field].push(pending);
      renderFormPhotos();
      try {
        const extMatch = (file.name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
        const ext = extMatch ? extMatch[1] : (file.type && file.type.split("/")[1]) || "jpg";
        const path = cryptoId() + "." + ext;
        const { error: uploadError } = await sb.storage.from(PHOTOS_BUCKET).upload(path, file, {
          contentType: file.type || "image/jpeg",
          cacheControl: "31536000",
        });
        if (uploadError) throw uploadError;
        const { data: pub } = sb.storage.from(PHOTOS_BUCKET).getPublicUrl(path);
        pending.uploading = false;
        pending.url = pub.publicUrl;
        pending.id = path;
        renderFormPhotos();
      } catch (e) {
        console.error("upload failed", e);
        const idx = STATE.formPhotos[field].indexOf(pending);
        if (idx >= 0) STATE.formPhotos[field].splice(idx, 1);
        renderFormPhotos();
        showToast("Couldn't upload. Try again.");
      }
    });
    input.click();
  }

  function renderMine() {
    const panel = document.getElementById("panel-mine");

    // No name yet → big name picker (works even before the DB loads)
    if (!STATE.name) {
      panel.innerHTML = `
        <div class="card" style="padding:24px 20px;">
          <div style="font-family: var(--font-display); font-weight: 600; font-size: 1.15rem; margin-bottom: 4px;">Who are you?</div>
          <div style="color: var(--fg-muted); font-size: 0.9rem; margin-bottom: 16px;">Pick your name to see what's on your plate.</div>
          <div class="name-picker">
            ${NAMES.map(n => `<button type="button" class="name-btn" data-pickname="${esc(n)}">${esc(n)}</button>`).join("")}
          </div>
        </div>`;
      panel.querySelectorAll("[data-pickname]").forEach(btn => {
        btn.addEventListener("click", () => {
          STATE.name = btn.dataset.pickname;
          saveStoredName(STATE.name);
          render();
        });
      });
      return;
    }

    if (!STATE.db) {
      panel.innerHTML = `<div class="notice"><strong>Not signed in</strong><p>Ask Ben to share this with your email.</p></div>`;
      return;
    }
    if (STATE.loading) { panel.innerHTML = `<div class="loading">Loading your plate…</div>`; return; }

    const me = STATE.name;
    const firstName = me.split(" ")[0];
    const assignedToMe = STATE.submissions
      .filter(s => s.status !== "improved" && getAssignees(s).includes(me))
      .sort((a, b) => new Date(b.assignedAt || b.createdAt || 0) - new Date(a.assignedAt || a.createdAt || 0));
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const myRecentWins = STATE.submissions
      .filter(s => s.status === "improved" && s.improvedBy === me && s.improvedAt && new Date(s.improvedAt).getTime() >= weekAgo)
      .sort((a, b) => new Date(b.improvedAt) - new Date(a.improvedAt));

    const todoCount = assignedToMe.length;
    const sharedWith = new Set();
    for (const s of assignedToMe) for (const a of getAssignees(s)) if (a !== me) sharedWith.add(a);
    const sharedBit = sharedWith.size > 0 ? ` <span style="color:var(--fg-muted);font-size:0.86rem;">· working with ${esc(formatAssignees(Array.from(sharedWith)))}</span>` : "";
    const heroSub = todoCount === 0
      ? `Nothing on your plate right now.`
      : `<span class="mine-hero-count">${todoCount}</span> ${todoCount === 1 ? "thing" : "things"} assigned to you.${sharedBit}`;

    let body = `
      <div class="mine-hero">
        <h2 class="mine-hero-greet">Hey ${esc(firstName)} 👋</h2>
        <p class="mine-hero-sub">${heroSub} <button class="link-btn" id="change-name-mine">Not you?</button></p>
      </div>`;

    if (assignedToMe.length === 0 && myRecentWins.length === 0) {
      body += `<div class="empty"><div class="empty-title">All clear 🌿</div><p>Nothing's on your plate. Nice work — check <strong>Feed</strong> to see what the crew's up to.</p></div>`;
    } else {
      if (assignedToMe.length > 0) {
        body += `<div class="section-head">On your plate <span class="count">${assignedToMe.length}</span></div>`;
        body += `<div class="entries">${assignedToMe.map(renderEntry).join("")}</div>`;
      }

      if (myRecentWins.length > 0) {
        body += `<div class="section-head">You improved this week <span class="count">${myRecentWins.length}</span></div>`;
        body += `<div class="entries">${myRecentWins.map(renderEntry).join("")}</div>`;
      }
    }

    panel.innerHTML = body;
    wireEntryActions(panel);
    const change = document.getElementById("change-name-mine");
    if (change) change.addEventListener("click", () => {
      STATE.name = "";
      saveStoredName("");
      syncWelcomeVisibility();
      render();
    });
  }

  function renderEveryone() {
    const panel = document.getElementById("panel-everyone");

    if (!STATE.db) {
      panel.innerHTML = `<div class="notice"><strong>Not signed in</strong><p>Ask Ben to share this with your email.</p></div>`;
      return;
    }
    if (STATE.loading) { panel.innerHTML = `<div class="loading">Loading…</div>`; return; }

    let banner = "";
    if (STATE.loadError === "slow") {
      banner = `<div class="notice" style="margin-bottom:12px;"><strong>Still waiting for the server.</strong><p>Entries may be out of date.</p></div>`;
    } else if (STATE.loadError && STATE.loadError !== "slow") {
      panel.innerHTML = `<div class="notice"><strong>Couldn't load entries.</strong><p>Reload the page or ask Ben to grant access.</p></div>`;
      return;
    }

    const subs = STATE.submissions;
    const filtered = filteredSubs();

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekCount = subs.filter((s) => s.createdAt && new Date(s.createdAt).getTime() >= weekAgo).length;
    const assigneeMatch = typeof STATE.filter === "string" && STATE.filter.startsWith("assignedto:");
    const assigneeName = assigneeMatch ? STATE.filter.slice("assignedto:".length) : "";
    const assigneeCount = assigneeMatch ? subs.filter((s) => s.status === "assigned" && getAssignees(s).includes(assigneeName)).length : 0;
    const assigneeChip = assigneeMatch
      ? `<button class="chip" aria-pressed="true" data-f="all" style="background:var(--progress);border-color:var(--progress);color:var(--primary-ink);">Open for ${esc(assigneeName)} (${assigneeCount}) ×</button>`
      : "";
    const filterChips = `
      <div class="filters" role="group" aria-label="Filter entries">
        ${assigneeChip}
        <button class="chip" aria-pressed="${STATE.filter === 'all'}" data-f="all">All (${subs.length})</button>
        <button class="chip" aria-pressed="${STATE.filter === 'week'}" data-f="week">This week (${weekCount})</button>
        <button class="chip" aria-pressed="${STATE.filter === 'progress'}" data-f="progress">In progress (${subs.filter(s=>s.status!=='improved').length})</button>
        <button class="chip" aria-pressed="${STATE.filter === 'improved'}" data-f="improved">Improved (${subs.filter(s=>s.status==='improved').length})</button>
        <button class="chip" aria-pressed="${STATE.filter === 'mine'}" data-f="mine">Just mine</button>
        <button class="chip" aria-pressed="${STATE.filter === 'byperson'}" data-f="byperson">By person</button>
      </div>`;

    let body;
    if (filtered.length === 0) {
      body = subs.length === 0
        ? `<div class="empty"><div class="empty-title">No entries yet</div><p>Be the first. Head to <strong>Submit</strong> and log one thing from today.</p></div>`
        : `<div class="empty"><p>Nothing matches that filter.</p></div>`;
    } else if (STATE.filter === "byperson") {
      body = renderByPerson(filtered);
    } else {
      body = `<div class="entries">${filtered.map(renderEntry).join("")}</div>`;
    }

    panel.innerHTML = banner + filterChips + body;
    wireEntryActions(panel);

    panel.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => { STATE.filter = chip.dataset.f; render(); });
    });
  }

  // ---- Inbox ----
  // Shows comments, nudges, updates, and status changes on entries where the
  // current user is the submitter or an assignee. "Unread" = created after the
  // user's last-read timestamp (per-device, in localStorage).

  // Kick off fetches for weekly + monthly if they aren't loaded yet.
  // Idempotent: once a promise is in flight we don't start another one.
  // For the weekly digest, if THIS week has no entries yet, we fall back
  // to last week's digest so the inbox still has something to show in the
  // first day or two of a new week.
  function ensureDigestsLoaded() {
    if (!STATE.insights.weekly && !STATE.insights._weeklyFetching) {
      STATE.insights._weeklyFetching = true;
      fnCall(FN.weekly, {}).then((out) => {
        if (out && (out.entry_count ?? 0) > 0) {
          STATE.insights.weekly = out;
          STATE.insights._weeklyFetching = false;
          render();
        } else {
          // Current week empty — show last week's digest instead.
          return fnCall(FN.weekly, { week_offset: -1 }).then((prev) => {
            STATE.insights.weekly = prev;
            STATE.insights._weeklyFetching = false;
            render();
          });
        }
      }).catch(() => { STATE.insights._weeklyFetching = false; });
    }
    if (!STATE.insights.monthly && !STATE.insights._monthlyFetching) {
      STATE.insights._monthlyFetching = true;
      fnCall(FN.monthly, { month_offset: -1 }).then((out) => {
        STATE.insights.monthly = out;
        STATE.insights._monthlyFetching = false;
        render();
      }).catch(() => { STATE.insights._monthlyFetching = false; });
    }
  }

  function readLastInboxRead() {
    try {
      const v = localStorage.getItem("don:inboxRead:" + STATE.name);
      return v ? Number(v) : 0;
    } catch { return 0; }
  }
  function saveLastInboxRead(ts) {
    try { localStorage.setItem("don:inboxRead:" + STATE.name, String(ts)); } catch {}
  }
  // Per-item read set — the mark-all-read timestamp still covers the bulk
  // case, but individual taps add just that one id so other unread items
  // stay unread until the user actually looks at them.
  function readInboxReadIds() {
    try {
      const v = localStorage.getItem("don:inboxReadIds:" + STATE.name);
      if (!v) return new Set();
      return new Set(JSON.parse(v));
    } catch { return new Set(); }
  }
  function saveInboxReadIds(set) {
    try {
      // Cap the set at 500 so it doesn't grow forever.
      const arr = Array.from(set).slice(-500);
      localStorage.setItem("don:inboxReadIds:" + STATE.name, JSON.stringify(arr));
    } catch {}
  }
  function markInboxItemRead(id) {
    if (!id) return;
    const set = readInboxReadIds();
    set.add(id);
    saveInboxReadIds(set);
    // Also drop it from the force-unread set (if the user had moved it back)
    const forced = readInboxForceUnreadIds();
    if (forced.delete(id)) saveInboxForceUnreadIds(forced);
  }

  // "Keep in inbox" — force an item to show as unread even if it's
  // older than the mark-all-read cutoff or was marked read by a tap.
  function readInboxForceUnreadIds() {
    try {
      const v = localStorage.getItem("don:inboxForceUnread:" + STATE.name);
      if (!v) return new Set();
      return new Set(JSON.parse(v));
    } catch { return new Set(); }
  }
  function saveInboxForceUnreadIds(set) {
    try {
      const arr = Array.from(set).slice(-500);
      localStorage.setItem("don:inboxForceUnread:" + STATE.name, JSON.stringify(arr));
    } catch {}
  }
  function keepInboxItemUnread(id) {
    if (!id) return;
    const forced = readInboxForceUnreadIds();
    forced.add(id);
    saveInboxForceUnreadIds(forced);
    // Also remove it from the read set
    const read = readInboxReadIds();
    if (read.delete(id)) saveInboxReadIds(read);
  }

  function isInboxItemUnread(item, cutoff, readIds, forcedIds) {
    if (forcedIds && forcedIds.has(item.id)) return true;
    if (readIds.has(item.id)) return false;
    return item.at > cutoff;
  }

  function collectInboxItems() {
    if (!STATE.name) return [];
    const me = STATE.name;
    const relevantEntries = new Map();
    for (const s of STATE.submissions) {
      const assignees = getAssignees(s);
      const iSubmitted = s.name === me;
      const iAssigned = assignees.includes(me);
      if (iSubmitted || iAssigned) {
        relevantEntries.set(s.id, { entry: s, role: iSubmitted ? "submitter" : "assignee" });
      }
    }
    const items = [];
    for (const c of STATE.comments) {
      const hit = relevantEntries.get(c.entryId);
      if (!hit) continue;
      if (c.author === me) continue; // skip my own comments
      items.push({
        kind: c.author === "Claude" ? "nudge" : "comment",
        entry: hit.entry,
        role: hit.role,
        who: c.author,
        text: c.text,
        at: new Date(c.createdAt).getTime(),
        id: c.id,
      });
    }
    for (const u of STATE.updates) {
      const hit = relevantEntries.get(u.entryId);
      if (!hit) continue;
      if (u.author === me) continue;
      items.push({
        kind: "update",
        entry: hit.entry,
        role: hit.role,
        who: u.author,
        text: u.text,
        at: new Date(u.createdAt).getTime(),
        id: u.id,
      });
    }
    // Status change: entry marked improved by someone else, after creation
    for (const [, { entry, role }] of relevantEntries) {
      if (entry.status === "improved" && entry.improvedBy && entry.improvedBy !== me && entry.improvedAt) {
        items.push({
          kind: "improved",
          entry,
          role,
          who: entry.improvedBy,
          text: entry.improvedNote || "",
          at: new Date(entry.improvedAt).getTime(),
          id: "imp-" + entry.id,
        });
      }
    }

    // New entries posted by other crew members — everyone sees them so nobody
    // misses something the team flagged. Skipped for your own submissions.
    for (const s of STATE.submissions) {
      if (s.name === me) continue;
      if (!s.createdAt) continue;
      items.push({
        kind: s.kind === "impact" ? "new-impact" : "new-problem",
        entry: s,
        role: "team",
        who: s.name,
        text: localized(s, "headline") || localized(s, "problem").slice(0, 100),
        at: new Date(s.createdAt).getTime(),
        id: "new-" + s.id,
      });
    }
    // AI insights: the weekly digest and last month's report go into every
    // crew member's inbox so nobody misses them. One item per digest; the
    // "created" timestamp is the digest's week_start / month_start so the
    // unread state naturally resets each new period.
    const w = STATE.insights?.weekly;
    if (w && (w.entry_count ?? 0) > 0 && w.summary) {
      items.push({
        kind: "digest",
        entry: null,
        role: "all",
        who: "Claude",
        text: w.summary,
        at: new Date(w.week_start || Date.now()).getTime(),
        id: "digest:week:" + (w.week_start || ""),
        digest: w,
        digestKind: "week",
      });
    }
    const m = STATE.insights?.monthly;
    if (m && (m.entry_count ?? 0) > 0 && m.exec_summary) {
      items.push({
        kind: "digest",
        entry: null,
        role: "all",
        who: "Claude",
        text: m.exec_summary,
        at: new Date(m.month_end || Date.now()).getTime(),
        id: "digest:month:" + (m.month_start || ""),
        digest: m,
        digestKind: "month",
      });
    }

    items.sort((a, b) => b.at - a.at);
    return items;
  }

  function unreadCount() {
    const items = collectInboxItems();
    const cutoff = readLastInboxRead();
    const readIds = readInboxReadIds();
    const forcedIds = readInboxForceUnreadIds();
    return items.filter((it) => isInboxItemUnread(it, cutoff, readIds, forcedIds)).length;
  }

  function paintInboxBadge() {
    const badge = document.getElementById("inbox-badge");
    if (!badge) return;
    const n = unreadCount();
    if (n > 0) {
      badge.hidden = false;
      badge.textContent = n > 99 ? "99+" : String(n);
    } else {
      badge.hidden = true;
    }
  }

  function renderInbox() {
    const panel = document.getElementById("panel-inbox");
    if (!STATE.name) {
      panel.innerHTML = `<div class="notice"><strong>Pick your name first</strong><p>Head back to the welcome screen so we know whose inbox to show.</p></div>`;
      return;
    }
    if (STATE.loading) { panel.innerHTML = `<div class="loading">Loading…</div>`; return; }

    // Make sure the weekly digest + monthly report are loaded before we render;
    // otherwise the digest card won't show until the background prefetch lands.
    ensureDigestsLoaded();

    const items = collectInboxItems();
    const cutoff = readLastInboxRead();
    const readIds = readInboxReadIds();
    const forcedIds = readInboxForceUnreadIds();

    // Split into unread (the real inbox) and read (hidden under a toggle)
    const unreadItems = items.filter((it) => isInboxItemUnread(it, cutoff, readIds, forcedIds));
    const readItems = items.filter((it) => !isInboxItemUnread(it, cutoff, readIds, forcedIds));
    const showingRead = STATE.inboxShowRead === true;

    if (items.length === 0) {
      panel.innerHTML = `<div class="empty">
        <div class="empty-title">Nothing in your inbox</div>
        <p>You'll see comments, Claude's check-ins, and new entries from the crew here.</p>
      </div>`;
      saveLastInboxRead(Date.now());
      paintInboxBadge();
      return;
    }

    // Decide which items to render based on the Unread/All subtab selection.
    const toRender = showingRead ? items : unreadItems;
    const newest = items[0].at;

    const KIND_META = {
      nudge:       { icon: "🤖", label: t("kindClaudeCheckin") },
      comment:     { icon: "💬", label: t("kindNewComment") },
      update:      { icon: "📝", label: t("kindStatusUpdate") },
      improved:    { icon: "✅", label: t("kindMarkedImproved") },
      digest:      { icon: "📊", label: t("kindWeeklyDigest") },
      "new-problem": { icon: "🪓", label: t("kindNewProblem") },
      "new-impact":  { icon: "💡", label: t("kindNewImpact") },
    };

    let html = `<div class="inbox">
      <div class="inbox-head">
        <div>
          <div class="inbox-title">${esc(t("inboxFor"))} ${esc(STATE.name)}</div>
        </div>
        <button type="button" class="link-btn" id="inbox-mark-read">${esc(t("inboxMarkAllRead"))}</button>
      </div>
      <div class="inbox-subtabs" role="tablist">
        <button type="button" class="inbox-subtab${!showingRead ? " is-active" : ""}" data-subtab="unread" role="tab" aria-selected="${!showingRead}">
          ${esc(t("inboxUnread"))} <span class="inbox-subtab-count">${unreadItems.length}</span>
        </button>
        <button type="button" class="inbox-subtab${showingRead ? " is-active" : ""}" data-subtab="all" role="tab" aria-selected="${showingRead}">
          ${esc(t("inboxAll"))} <span class="inbox-subtab-count">${items.length}</span>
        </button>
      </div>
      <div class="inbox-list">`;

    if (toRender.length === 0) {
      html += `<div class="inbox-empty-section">${esc(showingRead ? t("inboxEmptyRead") : t("inboxEmptyUnread"))}</div>`;
    }

    for (const it of toRender) {
      const meta = KIND_META[it.kind] || KIND_META.comment;
      const unread = isInboxItemUnread(it, cutoff, readIds, forcedIds);

      if (it.kind === "digest") {
        const langKey = STATE.lang || "en";
        // Pull language-specific sections from the digest body when available.
        const digestLang = it.digest?.[langKey] || it.digest;
        const kindLabel = it.digestKind === "month"
          ? (it.digest?.month ? `${it.digest.month}` : t("insightsMonth"))
          : t("kindWeeklyDigest");
        const displayText = it.digestKind === "month"
          ? (digestLang?.exec_summary || it.text)
          : (digestLang?.summary || it.text);
        const bullets = it.digestKind === "month"
          ? (digestLang?.improvements || []).slice(0, 2).map((x) => (x && x.title ? x.title : "")).filter(Boolean)
          : (digestLang?.wins || []).slice(0, 2);
        const bulletHtml = bullets.length
          ? `<ul class="inbox-digest-bullets">${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
          : "";
        html += `<button type="button" class="inbox-item inbox-item-digest${unread ? " is-unread" : ""}" data-inboxdigest="${esc(it.digestKind)}" data-inboxitemid="${esc(it.id)}">
          <div class="inbox-item-icon">${meta.icon}</div>
          <div class="inbox-item-body">
            <div class="inbox-item-row">
              <span class="inbox-item-kind">${esc(kindLabel)}</span>
              <span class="inbox-item-when">${timeAgo(it.at)}</span>
            </div>
            <div class="inbox-item-text">${esc(displayText)}</div>
            ${bulletHtml}
            <div class="inbox-item-context">${esc(t("roleForCrew"))}</div>
          </div>
          ${unread ? '<div class="inbox-dot" aria-label="unread"></div>' : ''}
        </button>`;
        continue;
      }

      let roleTag, bodyText, contextText;
      const headline = localized(it.entry, "headline") || localized(it.entry, "problem").slice(0, 80);

      if (it.kind === "new-problem" || it.kind === "new-impact") {
        roleTag = t("roleFromTeam");
        bodyText = `${esc(it.who)} ${esc(t("posted"))}: ${esc(it.text)}`;
        contextText = "";
      } else if (it.kind === "improved") {
        roleTag = it.role === "submitter" ? t("roleYourEntry") : t("roleAssigned");
        bodyText = `${esc(it.who)} ${esc(t("markedImprovedBy"))}`;
        contextText = esc(headline);
      } else {
        roleTag = it.role === "submitter" ? t("roleYourEntry") : t("roleAssigned");
        bodyText = `${esc(it.who)}: ${esc(it.text)}`;
        contextText = esc(headline);
      }

      const backLink = !unread
        ? `<span class="inbox-moveback" data-moveback="${esc(it.id)}" role="button" tabindex="0" title="${esc(t("inboxMoveBack"))}">${esc(t("inboxMoveBack"))}</span>`
        : "";
      html += `<div class="inbox-item-wrap">
        <button type="button" class="inbox-item${unread ? " is-unread" : ""}" data-inboxentry="${esc(it.entry.id)}" data-inboxitemid="${esc(it.id)}">
          <div class="inbox-item-icon">${meta.icon}</div>
          <div class="inbox-item-body">
            <div class="inbox-item-row">
              <span class="inbox-item-kind">${meta.label}</span>
              <span class="inbox-item-when">${timeAgo(it.at)}</span>
            </div>
            <div class="inbox-item-text">${bodyText}</div>
            <div class="inbox-item-context"><span class="inbox-item-role">${roleTag}</span>${contextText ? " · " + contextText : ""}</div>
          </div>
          ${unread ? '<div class="inbox-dot" aria-label="unread"></div>' : ''}
        </button>
        ${backLink}
      </div>`;
    }

    html += `</div></div>`;
    panel.innerHTML = html;

    panel.querySelector("#inbox-mark-read")?.addEventListener("click", () => {
      saveLastInboxRead(newest);
      STATE.inboxShowRead = false;
      render();
    });
    panel.querySelectorAll(".inbox-subtab").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.inboxShowRead = btn.dataset.subtab === "all";
        render();
      });
    });
    panel.querySelectorAll("[data-moveback]").forEach((link) => {
      link.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        keepInboxItemUnread(link.dataset.moveback);
        render();
      });
    });
    panel.querySelectorAll("[data-inboxentry]").forEach((row) => {
      row.addEventListener("click", () => {
        const entryId = row.dataset.inboxentry;
        const itemId = row.dataset.inboxitemid;
        const wasAlreadyRead = !row.classList.contains("is-unread");
        // Mark ONLY this specific item as read.
        markInboxItemRead(itemId);
        paintInboxBadge();
        // Only show "Move back to inbox" when the item was already read
        // (tapped from the All tab) — on first read it's unnecessary noise.
        openEntryDetail(entryId, wasAlreadyRead ? itemId : null);
      });
    });
    panel.querySelectorAll("[data-inboxdigest]").forEach((row) => {
      row.addEventListener("click", () => {
        const itemId = row.dataset.inboxitemid;
        markInboxItemRead(itemId);
        STATE.activeTab = "assignments";
        syncTabUI();
        render();
        requestAnimationFrame(() => {
          const target = document.querySelector(".insights");
          if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
        });
      });
    });
  }

  function timeAgo(ts) {
    const now = Date.now();
    const diff = Math.max(0, now - ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function renderAssignments() {
    const panel = document.getElementById("panel-assignments");

    if (!STATE.db) {
      panel.innerHTML = `<div class="notice"><strong>Not signed in</strong><p>Ask Ben to share this with your email.</p></div>`;
      return;
    }
    if (STATE.loading) { panel.innerHTML = `<div class="loading">Loading…</div>`; return; }

    const assigned = STATE.submissions.filter((s) => s.status !== "improved");
    const improved = STATE.submissions.filter((s) => s.status === "improved");

    if (assigned.length === 0 && improved.length === 0 && STATE.submissions.length === 0) {
      panel.innerHTML = `<div class="empty"><div class="empty-title">Nothing to do yet</div><p>Entries appear here once they're logged.</p></div>`;
      return;
    }

    let body = "";

    // Scoreboard hero — mountain climb + 14-day activity, always shown.
    body += renderScoreboard(improved);

    // AI Insights — weekly digest + last month's report.
    body += renderInsights();

    // Per-person workload summary — each person's open-assignment count
    if (assigned.length > 0) {
      const counts = new Map();
      for (const s of assigned) {
        for (const a of getAssignees(s)) {
          counts.set(a, (counts.get(a) || 0) + 1);
        }
      }
      const summaryRows = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1]);
      if (summaryRows.length > 0) {
        body += `<div class="section-head">Workload <span class="count">right now · tap to filter</span></div>`;
        body += `<div class="workload">`;
        for (const [person, n] of summaryRows) {
          const mine = person === STATE.name ? " is-me" : "";
          body += `<div class="workload-row${mine}" data-workloadperson="${esc(person)}" role="button" tabindex="0" aria-label="Show open assignments for ${esc(person)}"><span class="workload-name">${esc(person)}</span><span class="workload-num">${n} open</span></div>`;
        }
        body += `</div>`;
      }
    }

    if (assigned.length > 0) {
      const byPerson = new Map();
      for (const s of assigned) {
        const list = getAssignees(s);
        const keys = list.length ? list : ["Unassigned"];
        for (const key of keys) {
          if (!byPerson.has(key)) byPerson.set(key, []);
          byPerson.get(key).push(s);
        }
      }
      const ordered = Array.from(byPerson.entries()).sort((a, b) => b[1].length - a[1].length);
      body += `<div class="section-head">In progress <span class="count">${assigned.length}</span></div>`;
      for (const [person, items] of ordered) {
        body += `<div class="by-person">${esc(person)} · ${items.length}</div>`;
        body += `<div class="entries">${items.map(renderEntry).join("")}</div>`;
      }
    }

    panel.innerHTML = body;
    wireEntryActions(panel);
    wireScoreboard(panel);
    wireInsights(panel);
    panel.querySelectorAll("[data-workloadperson]").forEach((row) => {
      row.addEventListener("click", () => {
        STATE.activeTab = "everyone";
        STATE.filter = "assignedto:" + row.dataset.workloadperson;
        syncTabUI();
        render();
      });
    });
    requestAnimationFrame(positionClimber);
  }

  function renderInsights() {
    const lang = STATE.lang || "en";
    const w = STATE.insights.weekly;
    const m = STATE.insights.monthly;
    const loading = STATE.insights.loading;

    // Pull language-specific sections from the body, falling back to the
    // top-level (English) fields for older cached digests that didn't have
    // the per-language split.
    const wL = w ? (w[lang] || w) : null;
    const mL = m ? (m[lang] || m) : null;

    let out = `<div class="insights">
      <div class="insights-head">
        <span class="insights-title">${esc(t("insightsWeek"))}</span>
        <button type="button" class="link-btn" id="insights-refresh">${loading ? "…" : esc(t("insightsRefresh"))}</button>
      </div>`;
    if (!w && !loading) {
      out += `<div class="insights-empty"><button type="button" class="btn btn-ghost" id="insights-generate">${esc(t("insightsGenerate"))}</button></div>`;
    } else if (loading && !w) {
      out += `<div class="insights-empty">${esc(t("insightsLoading"))}</div>`;
    } else if (wL) {
      out += `<div class="insights-summary">${esc(wL.summary || "")}</div>`;
      if (wL.wins && wL.wins.length) {
        out += `<div class="insights-block"><div class="insights-label">${esc(t("insightsWins"))}</div><ul>${wL.wins.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
      }
      if (wL.open && wL.open.length) {
        out += `<div class="insights-block"><div class="insights-label">${esc(t("insightsOpen"))}</div><ul>${wL.open.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
      }
      if (wL.patterns && wL.patterns.length) {
        out += `<div class="insights-block"><div class="insights-label">${esc(t("insightsPatterns"))}</div><ul>${wL.patterns.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
      }
    }
    out += `</div>`;

    if (m && mL && mL.exec_summary) {
      out += `<div class="insights insights-month">
        <div class="insights-head">
          <span class="insights-title">${esc(t("insightsMonth"))} ${esc(m.month)}</span>
          <button type="button" class="link-btn" id="insights-month-refresh">${esc(t("insightsRefresh"))}</button>
        </div>
        <div class="insights-summary">${esc(mL.exec_summary)}</div>`;
      if (mL.improvements && mL.improvements.length) {
        out += `<div class="insights-block"><div class="insights-label">${esc(t("insightsImprovements"))}</div><ul>${mL.improvements.map((x) => `<li><strong>${esc(x.title)}:</strong> ${esc(x.detail)}</li>`).join("")}</ul></div>`;
      }
      if (mL.themes && mL.themes.length) {
        out += `<div class="insights-block"><div class="insights-label">${esc(t("insightsThemes"))}</div><div class="insights-chips">${mL.themes.map((th) => `<span class="insights-chip">${esc(th)}</span>`).join("")}</div></div>`;
      }
      out += `</div>`;
    }
    return out;
  }

  function wireInsights(panel) {
    const refresh = panel.querySelector("#insights-refresh");
    const generate = panel.querySelector("#insights-generate");
    const monthRefresh = panel.querySelector("#insights-month-refresh");
    // Shared fetcher: try current week; if it has no entries, fall back to
    // last week's digest so the panel (and inbox) always have something real.
    const load = async (force = false) => {
      STATE.insights.loading = true;
      render();
      try {
        const cur = await fnCall(FN.weekly, { force });
        if (cur && (cur.entry_count ?? 0) > 0) {
          STATE.insights.weekly = cur;
        } else {
          const prev = await fnCall(FN.weekly, { week_offset: -1, force });
          STATE.insights.weekly = prev || cur;
        }
      } catch (err) {
        console.warn("weekly digest failed", err);
      } finally {
        STATE.insights.loading = false;
        render();
      }
    };
    const loadMonth = async () => {
      try {
        STATE.insights.monthly = await fnCall(FN.monthly, { month_offset: -1, force: true });
        render();
      } catch (err) {
        console.warn("monthly report failed", err);
      }
    };
    if (refresh) refresh.addEventListener("click", () => load(true));
    if (generate) generate.addEventListener("click", () => load(false));
    if (monthRefresh) monthRefresh.addEventListener("click", loadMonth);

    // Lazy load the first time
    if (!STATE.insights.weekly && !STATE.insights.loading) load(false);
    if (!STATE.insights.monthly) {
      fnCall(FN.monthly, { month_offset: -1 }).then((out) => {
        STATE.insights.monthly = out;
        render();
      }).catch(() => { /* ignore */ });
    }
  }

  function wireLangToggle() {
    // Header: two-button EN/ES segmented toggle so both options are always
    // visible and one-tap switches the active language.
    const hEn = document.getElementById("lang-opt-en");
    const hEs = document.getElementById("lang-opt-es");
    const wEn = document.getElementById("welcome-lang-en");
    const wEs = document.getElementById("welcome-lang-es");

    const paintAll = () => {
      const isEs = STATE.lang === "es";
      if (hEn) { hEn.classList.toggle("is-active", !isEs); hEn.setAttribute("aria-checked", String(!isEs)); }
      if (hEs) { hEs.classList.toggle("is-active",  isEs); hEs.setAttribute("aria-checked", String( isEs)); }
      if (wEn)   wEn.classList.toggle("is-active", !isEs);
      if (wEs)   wEs.classList.toggle("is-active",  isEs);
    };

    const setLang = (lang) => {
      if (STATE.lang === lang) return;
      STATE.lang = lang;
      saveStoredLang(lang);
      STATE.translations = {};
      paintAll();
      paintStaticLabels();
      render();
    };

    paintAll();
    paintStaticLabels();
    if (hEn) hEn.addEventListener("click", () => setLang("en"));
    if (hEs) hEs.addEventListener("click", () => setLang("es"));
    if (wEn) wEn.addEventListener("click", () => setLang("en"));
    if (wEs) wEs.addEventListener("click", () => setLang("es"));
  }

  // Repaint the pieces of the static HTML shell (tabs, welcome screen,
  // stat labels) in the current language. Called on boot and on toggle.
  function paintStaticLabels() {
    const set = (selector, text) => {
      const el = document.querySelector(selector);
      if (el) el.textContent = text;
    };
    // Tab labels — preserve the badge <span> inside the Inbox tab.
    const tabs = {
      "#tab-submit": t("tabSubmit"),
      "#tab-mine": t("tabMine"),
      "#tab-everyone": t("tabFeed"),
      "#tab-assignments": t("tabScoreboard"),
    };
    for (const [sel, text] of Object.entries(tabs)) {
      const el = document.querySelector(sel);
      if (el) el.firstChild && el.firstChild.nodeType === 3
        ? (el.firstChild.nodeValue = text)
        : (el.textContent = text);
    }
    const inbox = document.getElementById("tab-inbox");
    if (inbox) {
      const badge = inbox.querySelector(".tab-badge");
      inbox.firstChild.nodeValue = t("tabInbox");
      if (badge && !inbox.contains(badge)) inbox.appendChild(badge);
    }
    set("#stat-week + .stat-label, [data-statfilter=\"week\"] .stat-label", t("statWeek"));
    set("[data-statfilter=\"progress\"] .stat-label", t("statProgress"));
    set("[data-statfilter=\"improved\"] .stat-label", t("statImproved"));
    set(".welcome-prompt", t("welcomePrompt"));
    set(".welcome-sub", t("welcomeSub"));
    set(".welcome-footer", t("welcomeFooter"));
  }

  function renderScoreboard(improved) {
    const range = STATE.scoreRange || "week";
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const inRange = range === "week"
      ? improved.filter((s) => s.improvedAt && new Date(s.improvedAt).getTime() >= weekAgo)
      : improved;

    const climbHtml = renderClimbHero(improved.length);
    const activityHtml = renderActivityStrip();

    const byPerson = new Map();
    for (const s of inRange) {
      const who = s.improvedBy || "—";
      byPerson.set(who, (byPerson.get(who) || 0) + 1);
    }
    const byCat = new Map();
    for (const s of inRange) {
      const c = s.category || "other";
      byCat.set(c, (byCat.get(c) || 0) + 1);
    }

    const peopleRows = Array.from(byPerson.entries()).sort((a, b) => b[1] - a[1]);
    const catRows = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]);
    const maxPeople = peopleRows.length ? peopleRows[0][1] : 1;
    const maxCat = catRows.length ? catRows[0][1] : 1;

    const toggle = `
      <div class="score-toggle" role="group" aria-label="Range">
        <button data-range="week" aria-pressed="${range === 'week'}">This week</button>
        <button data-range="all" aria-pressed="${range === 'all'}">All time</button>
      </div>`;

    const peopleBody = peopleRows.length === 0
      ? `<div class="score-empty">No one's improved anything ${range === 'week' ? 'this week' : 'yet'}.</div>`
      : peopleRows.map(([who, n], i) => {
          const top = i === 0 ? " is-top" : "";
          const trophy = i === 0 ? ` <span class="trophy">🏆</span>` : "";
          const pct = Math.round((n / maxPeople) * 100);
          return `<div class="scoreboard-row${top}">
            <span class="scoreboard-rank">${i + 1}</span>
            <span class="scoreboard-name">${esc(who)}${trophy}</span>
            <span class="scoreboard-bar"><span class="scoreboard-bar-fill" style="width:${pct}%"></span></span>
            <span class="scoreboard-num">${n}</span>
          </div>`;
        }).join("");

    const catBody = catRows.length === 0
      ? ""
      : catRows.map(([code, n]) => {
          const c = categoryByCode(code);
          const pct = Math.round((n / maxCat) * 100);
          return `<div class="scoreboard-row">
            <span class="scoreboard-name">${c.emoji} ${esc(c.label)}</span>
            <span class="scoreboard-bar"><span class="scoreboard-bar-fill" style="width:${pct}%"></span></span>
            <span class="scoreboard-num">${n}</span>
          </div>`;
        }).join("");

    return `
      ${climbHtml}
      ${activityHtml}
      ${renderCheerleader()}
      ${renderAchievements()}
      <div class="section-head" style="justify-content:space-between;align-items:center;">
        <span>Scoreboard <span class="count">${inRange.length} improved</span></span>
        ${toggle}
      </div>
      <div class="scoreboard">${peopleBody}</div>
      ${catBody ? `<div class="section-head">By category</div><div class="scoreboard">${catBody}</div>` : ""}
    `;
  }

  function computeCheerleader() {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const scores = new Map();
    for (const r of STATE.reactions) {
      if (!r.user || !r.createdAt) continue;
      if (new Date(r.createdAt).getTime() < weekAgo) continue;
      scores.set(r.user, (scores.get(r.user) || 0) + 1);
    }
    for (const c of STATE.comments) {
      if (!c.author || !c.createdAt) continue;
      if (new Date(c.createdAt).getTime() < weekAgo) continue;
      scores.set(c.author, (scores.get(c.author) || 0) + 1);
    }
    const rows = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    if (rows.length === 0) return null;
    const [name] = rows[0];
    let reactions = 0, comments = 0;
    for (const r of STATE.reactions) {
      if (r.user === name && r.createdAt && new Date(r.createdAt).getTime() >= weekAgo) reactions++;
    }
    for (const c of STATE.comments) {
      if (c.author === name && c.createdAt && new Date(c.createdAt).getTime() >= weekAgo) comments++;
    }
    return { name, reactions, comments };
  }

  function renderCheerleader() {
    const cheer = computeCheerleader();
    if (!cheer) {
      return `
        <div class="cheer-card">
          <div class="cheer-icon">📣</div>
          <div class="cheer-content">
            <div class="cheer-label">Hype Leader this week</div>
            <div class="cheer-empty">No reactions or comments yet this week — go hype someone up.</div>
          </div>
        </div>`;
    }
    const parts = [];
    if (cheer.reactions) parts.push(`${cheer.reactions} ${cheer.reactions === 1 ? "reaction" : "reactions"}`);
    if (cheer.comments) parts.push(`${cheer.comments} ${cheer.comments === 1 ? "comment" : "comments"}`);
    return `
      <div class="cheer-card">
        <div class="cheer-icon">📣</div>
        <div class="cheer-content">
          <div class="cheer-label">Hype Leader this week</div>
          <div class="cheer-name">${esc(cheer.name)}</div>
          <div class="cheer-stats">${parts.join(" · ") || "Showing up for the crew"}</div>
        </div>
      </div>`;
  }

  function computeTeamStreak() {
    // Business-day streak: Mon–Fri only. Weekends are skipped, not counted.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daySet = new Set();
    for (const s of STATE.submissions) {
      if (!s.createdAt) continue;
      const d = new Date(s.createdAt);
      d.setHours(0, 0, 0, 0);
      daySet.add(d.getTime());
    }
    const isWeekend = (d) => { const w = d.getDay(); return w === 0 || w === 6; };
    const cursor = new Date(today.getTime());
    // Jump back to the most recent business day if today is Sat/Sun.
    while (isWeekend(cursor)) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    for (let guard = 0; guard < 800; guard++) {
      if (isWeekend(cursor)) { cursor.setDate(cursor.getDate() - 1); continue; }
      if (daySet.has(cursor.getTime())) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  }

  function computeBestWeekImprovements() {
    const improved = STATE.submissions.filter((s) => s.status === "improved" && s.improvedAt);
    if (improved.length === 0) return 0;
    let best = 0;
    const times = improved.map((s) => new Date(s.improvedAt).getTime()).sort((a, b) => a - b);
    for (let i = 0; i < times.length; i++) {
      const end = times[i] + 7 * 24 * 60 * 60 * 1000;
      let n = 0;
      for (let j = i; j < times.length && times[j] <= end; j++) n++;
      if (n > best) best = n;
    }
    return best;
  }

  function computeAchievements() {
    const totalLogs = STATE.submissions.length;
    const improved = STATE.submissions.filter((s) => s.status === "improved");
    const totalImproved = improved.length;
    const impactLogs = STATE.submissions.filter((s) => s.kind === "impact").length;
    const difficultImproved = improved.filter((s) => (s.kind || "difficult") === "difficult").length;
    const totalReactions = STATE.reactions.length;
    const streak = computeTeamStreak();
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const peopleThisWeek = new Set();
    for (const s of STATE.submissions) {
      if (s.name && s.createdAt && new Date(s.createdAt).getTime() >= weekAgo) peopleThisWeek.add(s.name);
    }
    const bestWeek = computeBestWeekImprovements();
    return [
      { emoji: "🌱", label: "First Voice",      earned: totalLogs >= 1,          hint: "Spoke up first — logged an entry" },
      { emoji: "🌿", label: "Groundskeeper",    earned: totalImproved >= 10,     hint: "10 improvements completed — owns the day-to-day" },
      { emoji: "✂️", label: "Crew Lead",        earned: totalImproved >= 25,     hint: "25 improvements completed — leading by action" },
      { emoji: "🚜", label: "Foreman",          earned: totalImproved >= 50,     hint: "50 improvements completed — running the crew" },
      { emoji: "🏡", label: "Estate Manager",   earned: totalImproved >= 100,    hint: "100 improvements completed — running the operation" },
      { emoji: "🔥", label: "Pace Setter",      earned: streak >= 5,             hint: "5 business days in a row — sets the daily rhythm" },
      { emoji: "💪", label: "Steady Hand",      earned: streak >= 20,            hint: "20 business days in a row — monthly consistency" },
      { emoji: "👥", label: "Culture Builder",  earned: peopleThisWeek.size >= NAMES.length, hint: "Every teammate logged in one week — got the crew bought in" },
      { emoji: "💡", label: "Visionary",        earned: impactLogs >= 25,        hint: "25 impact moves logged — thinks strategically" },
      { emoji: "🛠️", label: "Problem Solver",   earned: difficultImproved >= 25, hint: "25 difficult things fixed — tackles the tough ones" },
      { emoji: "🏆", label: "Peak Week",        earned: bestWeek >= 10,          hint: "10 improvements in a 7-day stretch — season record" },
      { emoji: "👏", label: "Lifts the Crew",   earned: totalReactions >= 50,    hint: "50 reactions given — elevates teammates" },
    ];
  }

  function renderAchievements() {
    const list = computeAchievements();
    const earnedCount = list.filter((b) => b.earned).length;
    const chips = list.map((b) =>
      `<span class="badge-chip ${b.earned ? "earned" : ""}" title="${esc(b.hint)}"><span class="badge-emoji">${b.emoji}</span> ${esc(b.label)}</span>`
    ).join("");
    return `
      <div class="section-head">Achievements <span class="count">${earnedCount} of ${list.length}</span></div>
      <div class="achievements-row">${chips}</div>`;
  }

  function milestoneTier(target) {
    if (target <= 25) return "Trailhead";
    if (target <= 50) return "Base Camp";
    if (target <= 75) return "Alpine Ridge";
    if (target <= 100) return "Final Push";
    if (target <= 150) return "Second Summit";
    if (target <= 250) return "Summit Chain";
    return "Everest Season";
  }

  function renderClimbHero(allTimeCount) {
    const milestoneStep = 25;
    const nextMilestone = Math.ceil((allTimeCount + 1) / milestoneStep) * milestoneStep;
    const prevMilestone = nextMilestone - milestoneStep;
    const peaksConquered = Math.floor(allTimeCount / milestoneStep);
    const ratio = Math.min(1, Math.max(0, (allTimeCount - prevMilestone) / milestoneStep));
    const remaining = nextMilestone - allTimeCount;
    const tier = milestoneTier(nextMilestone);
    const sub = `${remaining} to go · next peak <strong>${nextMilestone}</strong>`;
    const peaksRow = peaksConquered > 0
      ? `<div class="peaks-conquered">${"🏔️".repeat(Math.min(peaksConquered, 8))}${peaksConquered > 8 ? ` +${peaksConquered - 8}` : ""} <span>${peaksConquered} peak${peaksConquered === 1 ? "" : "s"} conquered</span></div>`
      : "";

    return `
      <div class="climb-card" data-ratio="${ratio}">
        <svg class="climb-svg" viewBox="0 0 320 180" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <linearGradient id="climbSky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#F6B36A" stop-opacity="0.28"/>
              <stop offset="0.55" stop-color="var(--primary)" stop-opacity="0.14"/>
              <stop offset="1" stop-color="var(--surface)" stop-opacity="0"/>
            </linearGradient>
            <linearGradient id="mtnFace" x1="0" y1="0" x2="1" y2="0.35">
              <stop offset="0" stop-color="var(--primary)" stop-opacity="0.52"/>
              <stop offset="0.6" stop-color="var(--primary)" stop-opacity="0.36"/>
              <stop offset="1" stop-color="var(--primary)" stop-opacity="0.5"/>
            </linearGradient>
          </defs>
          <rect width="320" height="180" fill="url(#climbSky)"/>
          <circle cx="200" cy="55" r="22" fill="#FFC27A" opacity="0.45"/>
          <circle cx="200" cy="55" r="13" fill="#FFD9A8" opacity="0.55"/>
          <circle cx="30"  cy="22" r="0.9" fill="var(--fg)" opacity="0.4"/>
          <circle cx="58"  cy="38" r="0.6" fill="var(--fg)" opacity="0.32"/>
          <circle cx="92"  cy="16" r="0.8" fill="var(--fg)" opacity="0.4"/>
          <circle cx="270" cy="20" r="0.8" fill="var(--fg)" opacity="0.4"/>
          <circle cx="298" cy="35" r="0.6" fill="var(--fg)" opacity="0.32"/>
          <polygon points="-20,180 20,115 65,135 110,85 155,125 195,100 240,135 290,110 340,180" fill="var(--primary)" opacity="0.14"/>
          <polygon points="-10,180 45,100 90,140 155,75 195,110 255,90 330,145 330,180" fill="var(--primary)" opacity="0.22"/>
          <polygon points="10,180 75,120 115,150 200,32 245,110 280,145 320,180" fill="url(#mtnFace)"/>
          <polygon points="200,32 245,110 280,145 320,180 200,180" fill="#000" opacity="0.08"/>
          <polygon points="190,52 200,32 210,52 206,56 202,53 198,56 194,53" fill="var(--surface)"/>
          <polygon points="194,57 206,57 209,62 192,62" fill="var(--surface)" opacity="0.75"/>
          <path id="climbTrail" d="M 55 170 Q 90 150 110 135 Q 140 120 135 100 Q 165 90 170 70 Q 190 55 200 32"
                stroke="var(--primary)" stroke-width="2"
                stroke-dasharray="3 4" fill="none" opacity="0.7" stroke-linecap="round"/>
          <line x1="200" y1="32" x2="200" y2="12" stroke="var(--fg)" stroke-width="1.5"/>
          <polygon points="200,13 223,18 200,23" fill="var(--primary)"/>
          <text x="205" y="20.8" font-size="7.5" font-weight="700" font-family="Space Grotesk, sans-serif" fill="#FFF">P</text>
          <g>
            <rect x="40.5" y="160" width="1.5" height="12" fill="#6B4C2A"/>
            <rect x="27" y="148" width="28" height="12" rx="1.5" fill="#F0CDA3" stroke="#6B4C2A" stroke-width="0.6"/>
            <text x="41" y="154.5" font-size="4" font-weight="700" fill="#6B4C2A" text-anchor="middle" font-family="Space Grotesk, sans-serif">TRAILHEAD</text>
            <path d="M 32 158 L 50 158 M 48 156.5 L 50 158 L 48 159.5" stroke="#6B4C2A" stroke-width="0.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </g>
          <g id="climber" transform="translate(55 170)">
            <ellipse cx="-1" cy="8" rx="12" ry="1.2" fill="#000" opacity="0.18"/>
            <g class="rambo">
              <g class="rambo-tail">
                <path d="M -11 -4 Q -15 -9 -12 -12" stroke="#D4A574" stroke-width="2.3" fill="none" stroke-linecap="round"/>
              </g>
              <path d="M -8 2 L -9 7" stroke="#A26C3D" stroke-width="2.3" stroke-linecap="round"/>
              <path d="M -5 2 L -4 7" stroke="#A26C3D" stroke-width="2.3" stroke-linecap="round"/>
              <ellipse cx="-2" cy="-2" rx="8" ry="4.5" fill="#D4A574"/>
              <ellipse cx="0" cy="0.5" rx="5.5" ry="2.5" fill="#FFF"/>
              <rect x="-6" y="-9" width="7" height="4.2" rx="1.2" fill="#2563EB"/>
              <rect x="-5.5" y="-9.5" width="6" height="1.4" rx="0.4" fill="#1D4FBF"/>
              <circle cx="-2.5" cy="-7" r="0.45" fill="#F0CDA3"/>
              <path d="M 1 -6 Q 2 -3 1 0" stroke="#1D4FBF" stroke-width="0.9" fill="none"/>
              <path d="M 3 2 L 2 7" stroke="#A26C3D" stroke-width="2.3" stroke-linecap="round"/>
              <path d="M 6 2.5 L 7 7" stroke="#A26C3D" stroke-width="2.3" stroke-linecap="round"/>
              <ellipse cx="5.5" cy="-5" rx="1.5" ry="3" fill="#A26C3D" transform="rotate(-18 5.5 -5)"/>
              <ellipse cx="13.5" cy="-5" rx="1.5" ry="3" fill="#A26C3D" transform="rotate(18 13.5 -5)"/>
              <circle cx="9.5" cy="-5" r="4.5" fill="#D4A574"/>
              <ellipse cx="9.5" cy="-3.3" rx="2.3" ry="1.6" fill="#F0CDA3"/>
              <ellipse cx="9.5" cy="-3.8" rx="0.85" ry="0.65" fill="#2A1F18"/>
              <ellipse cx="9.5" cy="-2.1" rx="1" ry="0.6" fill="#E86E8A"/>
              <circle cx="8"    cy="-6"   r="0.85" fill="#2A1F18"/>
              <circle cx="11"   cy="-6"   r="0.85" fill="#2A1F18"/>
              <circle cx="8.2"  cy="-6.2" r="0.3"  fill="#FFF"/>
              <circle cx="11.2" cy="-6.2" r="0.3"  fill="#FFF"/>
              <path d="M 5.5 -1 Q 9.5 0.3 13.5 -1" stroke="#B33A3A" stroke-width="1.3" fill="none" stroke-linecap="round"/>
            </g>
            <text class="rambo-label" x="0" y="13" text-anchor="middle" font-size="6.5" font-weight="700" fill="var(--primary)" font-family="Space Grotesk, sans-serif" paint-order="stroke" stroke="var(--surface)" stroke-width="2.5">Rambo</text>
          </g>
        </svg>
        <div class="climb-meta">
          <div class="climb-left">
            <span class="climb-label">${esc(tier)}</span>
            <span class="climb-count">${allTimeCount}<span class="unit">improvements</span></span>
            ${peaksRow}
          </div>
          <div class="climb-sub">${sub}</div>
        </div>
        <div class="climb-tagline">🌱 The climb never ends — one improvement at a time</div>
      </div>`;
  }

  function positionClimber() {
    const trail = document.getElementById("climbTrail");
    const card = document.querySelector(".climb-card");
    const g = document.getElementById("climber");
    if (!trail || !card || !g) return;
    const ratio = Number(card.dataset.ratio) || 0;
    try {
      const L = trail.getTotalLength();
      const pt = trail.getPointAtLength(L * Math.min(1, Math.max(0, ratio)));
      g.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
    } catch (e) { /* SVG not ready */ }
  }

  function renderActivityStrip() {
    const days = 14;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const buckets = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      buckets.push({ date: d, count: 0 });
    }
    for (const s of STATE.submissions) {
      if (!s.createdAt) continue;
      const d = new Date(s.createdAt);
      d.setHours(0, 0, 0, 0);
      const idx = buckets.findIndex((b) => b.date.getTime() === d.getTime());
      if (idx >= 0) buckets[idx].count++;
    }
    const maxCount = Math.max(1, ...buckets.map((b) => b.count));

    // Business-day streak is the single source of truth, computed separately.
    const streak = computeTeamStreak();

    const bars = buckets.map((b, i) => {
      const pct = (b.count / maxCount) * 100;
      const isToday = i === buckets.length - 1;
      const has = b.count > 0;
      const w = b.date.getDay();
      const isWknd = w === 0 || w === 6;
      const dStr = b.date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
      return `<div class="daybar${isToday ? " today" : ""}${has ? " has" : ""}${isWknd ? " weekend" : ""}" style="--h:${pct}%" title="${dStr}${isWknd ? " (weekend)" : ""}: ${b.count}"><span class="daybar-fill"></span></div>`;
    }).join("");

    const streakHtml = streak > 0
      ? `<span class="streak-badge live">🔥 ${streak} business-day streak</span>`
      : `<span class="streak-badge">Start today's streak</span>`;

    return `
      <div class="activity-strip">
        <div class="activity-head">
          ${streakHtml}
          <span class="activity-title">Last 14 days</span>
        </div>
        <div class="daybars">${bars}</div>
      </div>`;
  }

  function wireScoreboard(root) {
    root.querySelectorAll(".score-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.scoreRange = btn.dataset.range;
        render();
      });
    });
  }

  function wireEntryActions(root) {
    root.querySelectorAll("[data-assign]").forEach((btn) => {
      btn.addEventListener("click", () => openAssignModal(btn.dataset.assign));
    });
    root.querySelectorAll("[data-complete]").forEach((btn) => {
      btn.addEventListener("click", () => openCompleteModal(btn.dataset.complete));
    });
    root.querySelectorAll("[data-reopen]").forEach((btn) => {
      btn.addEventListener("click", () => reopen(btn.dataset.reopen));
    });
    root.querySelectorAll("[data-undo]").forEach((btn) => {
      btn.addEventListener("click", () => undoImproved(btn.dataset.undo));
    });
    root.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", () => deleteEntry(btn.dataset.del));
    });
    root.querySelectorAll(".entry-photo").forEach((el) => {
      el.addEventListener("click", () => openLightbox(el.dataset.src));
    });
    root.querySelectorAll("[data-react]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [entryId, code] = btn.dataset.react.split(":");
        toggleReaction(entryId, code);
      });
    });
    root.querySelectorAll("[data-togglecomments]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.togglecomments;
        STATE.openCommentThread = STATE.openCommentThread === id ? null : id;
        render();
      });
    });
    root.querySelectorAll("[data-commentfor]").forEach((form) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        addComment(form.dataset.commentfor, text);
      });
    });
    root.querySelectorAll("[data-postupdate]").forEach((btn) => {
      btn.addEventListener("click", () => openUpdateModal(btn.dataset.postupdate));
    });
    root.querySelectorAll("[data-editchecklist]").forEach((btn) => {
      btn.addEventListener("click", () => openChecklistModal(btn.dataset.editchecklist));
    });
    root.querySelectorAll("[data-checktoggle]").forEach((row) => {
      row.addEventListener("click", () => {
        const [entryId, itemId] = row.dataset.checktoggle.split(":");
        toggleChecklistItem(entryId, itemId);
      });
    });
    root.querySelectorAll("[data-openrelated]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = STATE.submissions.find((x) => x.id === btn.dataset.openrelated);
        if (!target) { showToast("That entry isn't loaded."); return; }
        STATE.activeTab = "everyone";
        STATE.filter = "all";
        syncTabUI();
        render();
        setTimeout(() => {
          const panel = document.getElementById("panel-everyone");
          const el = panel && Array.from(panel.querySelectorAll(".entry")).find((e) => e.textContent.includes(target.problem.slice(0, 40)));
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 60);
      });
    });
  }

  // ---- Update posts ----
  function openUpdateModal(entryId) {
    if (!STATE.name) { showToast("Pick your name on Submit first."); return; }
    const entry = STATE.submissions.find((s) => s.id === entryId);
    if (!entry) return;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>Post an update</h3>
        <p><strong>${esc(entry.name)}:</strong> ${esc((entry.problem || "").slice(0, 120))}${(entry.problem || "").length > 120 ? "…" : ""}</p>
        <div class="field">
          <label>What's new?</label>
          <textarea id="u-text" maxlength="500" placeholder="e.g. Ordered the earmuffs today, arriving Friday"></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="u-cancel">Cancel</button>
          <button class="btn" id="u-save" style="width:auto;background:var(--primary);">Post update</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector("#u-cancel").addEventListener("click", close);
    backdrop.querySelector("#u-save").addEventListener("click", async () => {
      const text = backdrop.querySelector("#u-text").value.trim();
      if (!text) { showToast("Write something first."); return; }
      close();
      await postUpdate(entryId, text);
    });
    setTimeout(() => backdrop.querySelector("#u-text")?.focus(), 50);
  }
  async function postUpdate(entryId, text) {
    try {
      const id = cryptoId();
      const { error } = await sb.from("updates").insert([{
        id, entry_id: entryId, author: STATE.name, text, created_at: new Date().toISOString(),
      }]);
      if (error) throw error;
      showToast("Update posted ✓");
    } catch (e) { console.error(e); showToast("Couldn't post update."); }
  }

  // ---- Checklist ----
  function openChecklistModal(entryId) {
    if (!STATE.name) { showToast("Pick your name on Submit first."); return; }
    const entry = STATE.submissions.find((s) => s.id === entryId);
    if (!entry) return;
    const items = Array.isArray(entry.checklist) ? entry.checklist.map((i) => ({ ...i })) : [];
    const draft = { items };

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${items.length ? "Edit checklist" : "Add checklist"}</h3>
        <p><strong>${esc(entry.name)}:</strong> ${esc((entry.problem || "").slice(0, 120))}${(entry.problem || "").length > 120 ? "…" : ""}</p>
        <div class="field">
          <label>Items <span class="optional">(one per row)</span></label>
          <div class="list-editor" id="cl-items"></div>
          <button type="button" class="list-editor-add" id="cl-add">+ Add item</button>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cl-cancel">Cancel</button>
          <button class="btn" id="cl-save" style="width:auto;background:var(--primary);">Save</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const host = backdrop.querySelector("#cl-items");

    const paintRows = () => {
      host.innerHTML = draft.items.map((it, idx) => `
        <div class="check-editor-row">
          <input type="text" value="${esc(it.label || "")}" data-idx="${idx}" placeholder="e.g. Earmuffs for Matt" maxlength="120" />
          <div class="check-editor-sub">
            <select data-aidx="${idx}">
              <option value="">— unassigned —</option>
              ${NAMES.map((n) => `<option value="${esc(n)}" ${n === it.assignee ? "selected" : ""}>${esc(n)}</option>`).join("")}
            </select>
            <button type="button" data-rm="${idx}" aria-label="Remove">×</button>
          </div>
        </div>`).join("");
      host.querySelectorAll("input[data-idx]").forEach((inp) => {
        inp.addEventListener("input", () => { draft.items[Number(inp.dataset.idx)].label = inp.value; });
      });
      host.querySelectorAll("select[data-aidx]").forEach((sel) => {
        sel.addEventListener("change", () => { draft.items[Number(sel.dataset.aidx)].assignee = sel.value || null; });
      });
      host.querySelectorAll("[data-rm]").forEach((b) => {
        b.addEventListener("click", () => { draft.items.splice(Number(b.dataset.rm), 1); paintRows(); });
      });
    };
    if (draft.items.length === 0) draft.items.push({ id: cryptoId().slice(0, 8), label: "", done: false });
    paintRows();

    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector("#cl-cancel").addEventListener("click", close);
    backdrop.querySelector("#cl-add").addEventListener("click", () => {
      draft.items.push({ id: cryptoId().slice(0, 8), label: "", done: false });
      paintRows();
      const inputs = host.querySelectorAll("input");
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    });
    backdrop.querySelector("#cl-save").addEventListener("click", async () => {
      const cleaned = draft.items
        .map((i) => ({ ...i, label: (i.label || "").trim() }))
        .filter((i) => i.label);
      close();
      await saveChecklist(entryId, cleaned);
    });
  }
  async function saveChecklist(entryId, items) {
    try {
      const { error } = await sb.from("submissions").update({ checklist: items }).eq("id", entryId);
      if (error) throw error;
      showToast(items.length ? "Checklist saved ✓" : "Checklist cleared");
    } catch (e) { console.error(e); showToast("Couldn't save checklist."); }
  }
  async function toggleChecklistItem(entryId, itemId) {
    if (!STATE.name) { showToast("Pick your name on Submit first."); return; }
    const entry = STATE.submissions.find((s) => s.id === entryId);
    if (!entry || !Array.isArray(entry.checklist)) return;
    const items = entry.checklist.map((it) => {
      if (it.id !== itemId) return it;
      const nowDone = !it.done;
      return nowDone
        ? { ...it, done: true, doneBy: STATE.name, doneAt: new Date().toISOString() }
        : { ...it, done: false, doneBy: null, doneAt: null };
    });
    const allDone = items.length > 0 && items.every((i) => i.done);
    const shouldAutoComplete = allDone && entry.status !== "improved";
    const payload = { checklist: items };
    if (shouldAutoComplete) {
      const now = new Date().toISOString();
      payload.status = "improved";
      payload.improved_by = STATE.name;
      payload.improved_at = now;
      payload.improved_note = "All checklist items completed.";
    }
    try {
      const { error } = await sb.from("submissions").update(payload).eq("id", entryId);
      if (error) throw error;
      if (shouldAutoComplete) showToast("✓ All checked off — marked complete!");
    } catch (e) { console.error(e); showToast("Couldn't update."); }
  }

  function filteredSubs() {
    let list = STATE.submissions.slice();
    if (STATE.filter === "progress") list = list.filter((s) => s.status !== "improved");
    else if (STATE.filter === "improved") list = list.filter((s) => s.status === "improved");
    else if (STATE.filter === "week") {
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      list = list.filter((s) => s.createdAt && new Date(s.createdAt).getTime() >= weekAgo);
    }
    else if (STATE.filter === "mine") {
      const me = STATE.name.toLowerCase();
      list = me ? list.filter((s) => (s.name || "").toLowerCase() === me) : [];
    }
    else if (typeof STATE.filter === "string" && STATE.filter.startsWith("assignedto:")) {
      const who = STATE.filter.slice("assignedto:".length);
      list = list.filter((s) => s.status === "assigned" && getAssignees(s).includes(who));
    }
    return list;
  }

  function renderByPerson(list) {
    const groups = new Map();
    for (const s of list) {
      const key = (s.name || "Unknown").trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const ordered = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
    return ordered.map(([name, items]) => {
      const improved = items.filter((i) => i.status === "improved").length;
      return `
        <div class="by-person">${esc(name)} · ${items.length} ${items.length === 1 ? "entry" : "entries"} · ${improved} improved</div>
        <div class="entries">${items.map(renderEntry).join("")}</div>
      `;
    }).join("");
  }

  function renderProblemText(s) {
    const headline = (localized(s, "headline") || "").trim();
    const problem = (localized(s, "problem") || "").trim();
    if (headline) {
      return `<div class="entry-problem entry-problem-headline">${esc(headline)}</div>${problem ? `<div class="entry-problem-rest">${esc(problem)}</div>` : ""}`;
    }
    return `<div class="entry-problem">${esc(problem)}</div>`;
  }

  function renderEntry(s) {
    const status = s.status || "open";
    const kind = s.kind || "difficult";
    const isImpact = kind === "impact";

    const effectiveStatus = status === "improved" ? "improved" : "assigned";
    let statusLabel;
    if (effectiveStatus === "improved") statusLabel = isImpact ? "Completed" : "Improved";
    else statusLabel = "In progress";

    let pillHtml;
    if (effectiveStatus === "improved") pillHtml = `<span class="pill pill-improved">${statusLabel}</span>`;
    else pillHtml = `<span class="pill pill-progress">${statusLabel}</span>`;

    const kindPill = isImpact
      ? `<span class="pill pill-kind-impact">💡 Impact</span>`
      : `<span class="pill pill-kind-hard">🪓 Difficult</span>`;

    const cat = categoryByCode(s.category || "other");
    const catPill = s.category ? `<span class="pill pill-category">${cat.emoji} ${esc(cat.label)}</span>` : "";

    const date = s.createdAt ? formatDate(s.createdAt) : "";
    const isNew = s.createdAt && (Date.now() - new Date(s.createdAt).getTime() < 60000) && (new Date(s.createdAt).getTime() > STATE.bootedAt);

    const assigneesForHead = getAssignees(s);
    const assigneeChip = effectiveStatus === "assigned" && assigneesForHead.length > 0
      ? `<span class="entry-assignee-chip">${esc(t("entryLabelAssignedTo"))} 👉 ${esc(formatAssignees(assigneesForHead))}</span>`
      : "";

    const problemPhotos = renderPhotoGrid(s.problemPhotos);
    const solutionPhotos = renderPhotoGrid(s.solutionPhotos);

    const localizedImpact = localized(s, "impact");
    const localizedSolution = localized(s, "solution");

    const impactSection = (localizedImpact && localizedImpact.trim())
      ? `<div class="entry-section impact"><span class="entry-section-label">${esc(t("entryLabelImpact"))}</span><div class="section-body">${esc(localizedImpact)}</div></div>`
      : "";

    let solSectionLabel;
    if (isImpact) solSectionLabel = t("entryLabelWhyMatters");
    else solSectionLabel = status === "improved" ? t("entryLabelSolution") : t("entryLabelPotential");

    const solSection = (localizedSolution && localizedSolution.trim()) || (s.solutionPhotos && s.solutionPhotos.length)
      ? `<div class="entry-section potential"><span class="entry-section-label">${solSectionLabel}</span>${localizedSolution ? `<div class="section-body">${esc(localizedSolution)}</div>` : ""}${solutionPhotos}</div>`
      : "";

    const checklistBlock = renderChecklist(s);
    const updatesBlock = renderUpdates(s.id);

    const assignees = getAssignees(s);
    const assignedSection = effectiveStatus === "assigned" && assignees.length > 0
      ? `<div class="entry-section assigned"><span class="entry-section-label">Assigned to ${esc(formatAssignees(assignees))}</span><div class="section-body">${s.assignmentNote ? esc(s.assignmentNote) : "No instructions yet."}</div><div class="meta">Assigned${s.assignedBy ? " by " + esc(s.assignedBy) : ""}${s.assignedAt ? " · " + formatDate(s.assignedAt) : ""}</div></div>`
      : "";

    const improvedLabelBase = isImpact ? "Completed" : "Fix";
    const improvedSection = status === "improved" && s.improvedNote && s.improvedNote !== s.solution
      ? `<div class="entry-section improved"><span class="entry-section-label">${improvedLabelBase} ${s.improvedBy ? "— " + esc(s.improvedBy) : ""}</span><div class="section-body">${esc(s.improvedNote)}</div><div class="meta">${s.improvedAt ? "Completed " + formatDate(s.improvedAt) : ""}</div></div>`
      : (status === "improved"
          ? `<div class="improved-line"><span>✓ ${isImpact ? "Completed" : "Marked improved"}${s.improvedBy ? " by " + esc(s.improvedBy) : ""}</span>${s.improvedAt ? `<span class="improved-line-date">${esc(formatDate(s.improvedAt))}</span>` : ""}</div>`
          : "");

    const reactionRow = renderReactionRow(s.id);
    const commentsBlock = renderCommentsBlock(s.id);

    let actions = "";
    const buttons = [];
    const isAssignee = isAssignedToMe(s);
    if (STATE.isOwner) {
      if (effectiveStatus === "assigned") {
        buttons.push(`<button class="btn btn-ghost" data-assign="${esc(s.id)}">Reassign</button>`);
        buttons.push(`<button class="btn btn-ghost" data-complete="${esc(s.id)}">Mark improved</button>`);
        buttons.push(`<button class="btn btn-ghost" data-del="${esc(s.id)}" style="color:var(--danger);">Delete</button>`);
      } else if (effectiveStatus === "improved") {
        buttons.push(`<button class="btn btn-ghost" data-undo="${esc(s.id)}">Undo improved</button>`);
        buttons.push(`<button class="btn btn-ghost" data-del="${esc(s.id)}" style="color:var(--danger);">Delete</button>`);
      }
    } else if (STATE.name && effectiveStatus === "assigned") {
      buttons.push(`<button class="btn" data-complete="${esc(s.id)}" style="background:var(--improved);">Mark complete</button>`);
      buttons.push(`<button class="btn btn-ghost" data-assign="${esc(s.id)}">Reassign</button>`);
    }
    if (buttons.length) actions = `<div class="entry-actions">${buttons.join("")}</div>`;

    const miniActions = STATE.name
      ? `<div class="entry-mini-actions">
          <button class="mini-btn" data-postupdate="${esc(s.id)}">+ Update</button>
          <button class="mini-btn" data-editchecklist="${esc(s.id)}">${s.checklist && s.checklist.length ? "Edit checklist" : "+ Checklist"}</button>
        </div>`
      : "";

    return `
      <div class="entry${isNew ? " is-new" : ""}" id="entry-${esc(s.id)}">
        <div class="entry-head">
          ${pillHtml}
          ${kindPill}
          ${catPill}
          <span class="entry-name"><span class="entry-name-label">${esc(t("entryLabelSubmittedBy"))}</span> ${esc(s.name || "—")}</span>
          <span class="entry-date">${esc(date)}</span>
          ${assigneeChip}
        </div>
        <div class="entry-problem-box ${isImpact ? "is-impact" : ""}">
          <span class="entry-problem-label">${esc(isImpact ? t("entryLabelMove") : t("entryLabelProblem"))}</span>
          ${renderProblemText(s)}
        </div>
        ${problemPhotos}
        ${impactSection}
        ${solSection}
        ${checklistBlock}
        ${assignedSection}
        ${improvedSection}
        ${updatesBlock}
        ${reactionRow}
        ${commentsBlock}
        ${miniActions}
        ${actions}
      </div>`;
  }

  function renderChecklist(s) {
    const items = Array.isArray(s.checklist) ? s.checklist : [];
    if (items.length === 0) return "";
    const doneCount = items.filter((i) => i.done).length;
    const rows = items.map((it) => {
      const metaBits = [];
      if (!it.done && it.assignee) metaBits.push(`<span class="check-assignee">→ ${esc(it.assignee)}</span>`);
      if (it.done && it.doneBy) metaBits.push(esc(it.doneBy));
      if (it.done && it.doneAt) metaBits.push(esc(formatDate(it.doneAt)));
      const meta = metaBits.length ? `<span class="check-meta">${metaBits.join(" · ")}</span>` : "";
      return `<div class="check-item ${it.done ? "done" : ""}" data-checktoggle="${esc(s.id)}:${esc(it.id)}">
        <span class="check-box">${it.done ? "✓" : ""}</span>
        <span class="check-label">${esc(it.label || "")}</span>
        ${meta}
      </div>`;
    }).join("");
    return `<div class="checklist">
      <div class="checklist-label"><span>Checklist <span class="count">${doneCount}/${items.length}</span></span></div>
      ${rows}
    </div>`;
  }

  function renderUpdates(entryId) {
    const list = STATE.updates.filter((u) => u.entryId === entryId);
    if (list.length === 0) return "";
    const rows = list.map((u) => `
      <div class="update-item">
        <div class="update-meta"><strong>${esc(u.author || "")}</strong> · ${esc(formatDate(u.createdAt || ""))}</div>
        ${esc(u.text || "")}
      </div>`).join("");
    return `<div class="updates-block">
      <div class="updates-label">📌 Updates <span class="count">${list.length}</span></div>
      ${rows}
    </div>`;
  }

  function renderPhotoGrid(photos) {
    if (!photos || !photos.length) return "";
    return `<div class="entry-photos">${photos.map((p) => `
      <div class="entry-photo" data-src="${esc(p)}" style="background-image:url('${esc(p)}')" role="button" aria-label="Open photo"></div>
    `).join("")}</div>`;
  }

  function renderReactionRow(entryId) {
    const byCode = {};
    const myByCode = {};
    for (const r of STATE.reactions) {
      if (r.entryId !== entryId) continue;
      if (!byCode[r.code]) byCode[r.code] = [];
      byCode[r.code].push(r.user || "");
      if (r.user === STATE.name) myByCode[r.code] = r.id;
    }
    const btns = REACTIONS.map((r) => {
      const users = byCode[r.code] || [];
      const n = users.length;
      const mine = !!myByCode[r.code];
      const names = users.join(", ");
      return `<button class="reaction-btn ${mine ? "is-mine" : ""}" data-react="${esc(entryId)}:${r.code}" title="${esc(names)}" aria-label="${r.code}">
        <span class="reaction-char">${r.char}</span>${n > 0 ? `<span class="reaction-count">${n}</span>` : ""}
      </button>`;
    }).join("");

    const attrBits = [];
    for (const r of REACTIONS) {
      const users = byCode[r.code] || [];
      if (users.length === 0) continue;
      attrBits.push(`<span class="react-attr-item"><span class="react-attr-char">${r.char}</span>${esc(users.join(", "))}</span>`);
    }
    const attrLine = attrBits.length > 0 ? `<div class="react-attr">${attrBits.join("")}</div>` : "";

    return `<div class="reaction-row">${btns}</div>${attrLine}`;
  }

  function renderCommentsBlock(entryId) {
    const entryComments = STATE.comments.filter((c) => c.entryId === entryId);
    const isOpen = STATE.openCommentThread === entryId;
    const commenters = Array.from(new Set(entryComments.map((c) => c.author || "").filter(Boolean)));
    const preview = commenters.length <= 3
      ? commenters.join(", ")
      : commenters.slice(0, 2).join(", ") + " +" + (commenters.length - 2);
    const header = `<button class="comments-toggle" data-togglecomments="${esc(entryId)}">
      💬 ${entryComments.length > 0
        ? `${entryComments.length} comment${entryComments.length === 1 ? "" : "s"}${commenters.length ? " — " + esc(preview) : ""}`
        : "Say something"}
      ${isOpen ? " ▴" : " ▾"}
    </button>`;

    if (!isOpen) return `<div class="comments-section">${header}</div>`;

    const list = entryComments.length > 0 ? `
      <div class="comments-list">
        ${entryComments.map((c) => `
          <div class="comment-item">
            <div class="comment-meta"><strong>${esc(c.author || "")}</strong><span class="comment-date">${esc(formatDate(c.createdAt || ""))}</span></div>
            <div class="comment-text">${esc(c.text || "")}</div>
          </div>
        `).join("")}
      </div>` : "";

    const composer = STATE.name
      ? `<form class="comment-composer" data-commentfor="${esc(entryId)}">
          <input type="text" placeholder="Nice one! …" maxlength="500" />
          <button type="submit" class="btn">Post</button>
        </form>`
      : `<div class="comment-nologin">Pick your name on the Submit tab to join the thread.</div>`;

    return `<div class="comments-section open">${header}${list}${composer}</div>`;
  }

  // ---- Actions ----
  async function onSubmit(e) {
    e.preventDefault();
    if (STATE.pending) return;

    const form = e.currentTarget;
    const nameSelect = form.querySelector("#f-name");
    const name = nameSelect ? String(nameSelect.value || "").trim() : STATE.name;
    const problem = String(form.querySelector("#f-problem").value || "").trim();
    const impact = String(form.querySelector("#f-impact")?.value || "").trim();
    const solution = String(form.querySelector("#f-solution").value || "").trim();
    const aRaw = String(form.querySelector("#f-assign-a")?.value || "").trim();
    const bRaw = String(form.querySelector("#f-assign-b")?.value || "").trim();
    const assignees = [aRaw, bRaw].filter(Boolean);
    if (assignees.length === 2 && assignees[0] === assignees[1]) {
      showToast("Pick two different people for the second assignee.");
      return;
    }
    let status = STATE.submitStatus === "improved" ? "improved" : "assigned";

    if (!name) { nameSelect?.focus(); return; }
    if (!NAMES.includes(name)) { showToast("Pick your name from the list."); return; }
    if (!problem) { form.querySelector("#f-problem").focus(); return; }

    const stillUploading =
      STATE.formPhotos.problem.some((p) => p.uploading) ||
      STATE.formPhotos.solution.some((p) => p.uploading);
    if (stillUploading) { showToast("Photos are still uploading — hold on."); return; }

    STATE.pending = true;
    const btn = document.getElementById("submit-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

    try {
      const id = cryptoId();
      const now = new Date().toISOString();
      const doc = {
        name, problem, solution, impact,
        problemPhotos: STATE.formPhotos.problem.map((p) => p.url).filter(Boolean),
        solutionPhotos: STATE.formPhotos.solution.map((p) => p.url).filter(Boolean),
        status: status,
        kind: STATE.submitKind || "difficult",
        category: STATE.submitCategory || "other",
        createdAt: now,
      };
      if (status === "assigned") {
        const list = assignees.length > 0 ? assignees : [name];
        doc.assignees = list;
        doc.assignedTo = list[0];
        doc.assignedBy = name;
        doc.assignedAt = now;
        doc.assignmentNote = assignees.length === 0 ? "Taking it myself." : "";
      } else if (status === "improved") {
        doc.improvedBy = name;
        doc.improvedAt = now;
        doc.improvedNote = solution;
      }
      const insertRow = {
        id,
        name: doc.name,
        problem: doc.problem,
        solution: doc.solution,
        impact: doc.impact || null,
        problem_photos: doc.problemPhotos,
        solution_photos: doc.solutionPhotos,
        status: doc.status,
        kind: doc.kind,
        category: doc.category,
        created_at: doc.createdAt,
        checklist: [],
        related_to: [],
        assignees: doc.assignees || null,
        assigned_to: doc.assignedTo || null,
        assigned_by: doc.assignedBy || null,
        assigned_at: doc.assignedAt || null,
        assignment_note: doc.assignmentNote || null,
        improved_by: doc.improvedBy || null,
        improved_at: doc.improvedAt || null,
        improved_note: doc.improvedNote || null,
      };
      const { error: insertError } = await sb.from("submissions").insert([insertRow]);
      if (insertError) throw insertError;
      kickHeadlineGeneration({ id, problem: doc.problem, solution: doc.solution, impact: doc.impact });
      STATE.name = name;
      saveStoredName(name);
      STATE.formPhotos = { problem: [], solution: [] };
      const wasImpact = STATE.submitKind === "impact";
      STATE.submitStatus = "assigned";
      STATE.submitKind = "difficult";
      STATE.submitCategory = "other";
      STATE.submitAssignees = ["", ""];
      const doneTxt = wasImpact ? "completed" : "solved";
      let toastMsg;
      if (status === "improved") toastMsg = `Logged & ${doneTxt} ✓`;
      else if (status === "assigned" && assignees.length > 0) {
        const soloSelf = assignees.length === 1 && assignees[0] === name;
        toastMsg = soloSelf ? "Logged — on it ✓" : `Logged — assigned to ${formatAssignees(assignees)} ✓`;
      }
      else if (status === "assigned") toastMsg = "Logged — on it ✓";
      else toastMsg = "Logged ✓";
      showToast(toastMsg);
      const p = form.querySelector("#f-problem"); if (p) p.value = "";
      const sf = form.querySelector("#f-solution"); if (sf) sf.value = "";
      const im = form.querySelector("#f-impact"); if (im) im.value = "";
      render();
    } catch (err) {
      console.error("submit failed", err);
      if (err?.code === "invalid_argument") showToast("You need Edit access to submit. Ask Ben.");
      else if (err?.code === "resource_exhausted") showToast("Too fast — try again in a moment.");
      else if (err?.code === "quota_exceeded") showToast("Database is full — ask Ben to clean up old entries.");
      else showToast("Couldn't save. Try again.");
    } finally {
      STATE.pending = false;
      if (btn) { btn.disabled = false; btn.textContent = submitButtonLabel(); }
    }
  }

  function slugName(n) {
    return String(n || "").replace(/[^A-Za-z0-9_\-.~:@+]/g, "-").slice(0, 60);
  }

  function getAssignees(s) {
    if (Array.isArray(s.assignees)) return s.assignees.filter(Boolean);
    if (s.assignedTo) return [s.assignedTo];
    return [];
  }
  function isAssignedToMe(s) {
    return STATE.name && getAssignees(s).includes(STATE.name);
  }
  function formatAssignees(list) {
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    if (list.length === 2) return list[0] + " & " + list[1];
    return list.slice(0, -1).join(", ") + " & " + list[list.length - 1];
  }

  async function toggleReaction(entryId, code) {
    if (!STATE.db) return;
    if (!STATE.name) { showToast("Pick your name on Submit first."); return; }
    const docId = `${entryId}__${slugName(STATE.name)}__${code}`;
    const mine = STATE.reactions.find((r) => r.id === docId);
    try {
      if (mine) {
        const { error } = await sb.from("reactions").delete().eq("id", docId);
        if (error) throw error;
      } else {
        const { error } = await sb.from("reactions").insert([{
          id: docId, entry_id: entryId, username: STATE.name, code, created_at: new Date().toISOString(),
        }]);
        if (error) throw error;
      }
    } catch (e) {
      console.error("reaction failed", e);
      if (e?.code === "invalid_argument") showToast("You need Edit access to react.");
      else showToast("Couldn't react.");
    }
  }

  async function addComment(entryId, text) {
    if (!STATE.db || !STATE.name) {
      if (!STATE.name) showToast("Pick your name on Submit first.");
      return;
    }
    const id = cryptoId();
    try {
      const { error } = await sb.from("comments").insert([{
        id, entry_id: entryId, author: STATE.name, text, created_at: new Date().toISOString(),
      }]);
      if (error) throw error;
    } catch (e) {
      console.error("comment failed", e);
      if (e?.code === "invalid_argument") showToast("You need Edit access to comment.");
      else showToast("Couldn't post.");
    }
  }

  function openAssignModal(id) {
    const entry = STATE.submissions.find((s) => s.id === id);
    if (!entry) return;
    const current = getAssignees(entry);
    const currentNote = entry.assignmentNote || "";
    const hasAny = current.length > 0;
    const draft = { assignees: current.length ? current.slice() : [""] };

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="assign-title">
        <h3 id="assign-title">${hasAny ? "Reassign this" : "Assign this"}</h3>
        <p><strong>${esc(entry.name)}:</strong> ${esc((entry.problem || "").slice(0, 120))}${(entry.problem || "").length > 120 ? "…" : ""}</p>
        <div class="field">
          <label>Who's working on it?</label>
          <div class="list-editor" id="assign-rows"></div>
          <button type="button" class="list-editor-add" id="assign-add">+ Add another person</button>
        </div>
        <div class="field">
          <label>What should they do? <span class="optional">(optional)</span></label>
          <textarea id="assign-note" maxlength="500" placeholder="e.g. Order spare trimmer line spools for each truck by Friday">${esc(currentNote)}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="a-cancel">Cancel</button>
          <button class="btn" id="a-save" style="width:auto;background:var(--progress);">Assign</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const host = backdrop.querySelector("#assign-rows");

    const paintRows = () => {
      host.innerHTML = draft.assignees.map((picked, idx) => {
        const canRemove = draft.assignees.length > 1;
        return `<div class="list-editor-row">
          <select data-aidx="${idx}">
            <option value="" disabled ${picked ? "" : "selected"}>— choose —</option>
            ${NAMES.map((n) => `<option value="${esc(n)}" ${n === picked ? "selected" : ""}>${esc(n)}</option>`).join("")}
          </select>
          ${canRemove ? `<button type="button" data-armrm="${idx}" aria-label="Remove">×</button>` : ""}
        </div>`;
      }).join("");
      host.querySelectorAll("select[data-aidx]").forEach((sel) => {
        sel.addEventListener("change", () => { draft.assignees[Number(sel.dataset.aidx)] = sel.value; });
      });
      host.querySelectorAll("[data-armrm]").forEach((btn) => {
        btn.addEventListener("click", () => {
          draft.assignees.splice(Number(btn.dataset.armrm), 1);
          paintRows();
        });
      });
    };
    paintRows();

    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector("#a-cancel").addEventListener("click", close);
    backdrop.querySelector("#assign-add").addEventListener("click", () => {
      draft.assignees.push("");
      paintRows();
    });
    backdrop.querySelector("#a-save").addEventListener("click", async () => {
      const list = Array.from(new Set(draft.assignees.filter(Boolean)));
      const note = backdrop.querySelector("#assign-note").value.trim();
      if (list.length === 0) { showToast("Pick at least one person."); return; }
      close();
      await assignTo(id, list, note);
    });
    setTimeout(() => host.querySelector("select")?.focus(), 50);
  }

  async function assignTo(id, assigneeList, note) {
    try {
      const { error } = await sb.from("submissions").update({
        status: "assigned",
        assignees: assigneeList,
        assigned_to: assigneeList[0],
        assigned_by: STATE.name || "Owner",
        assigned_at: new Date().toISOString(),
        assignment_note: note || "",
      }).eq("id", id);
      if (error) throw error;
      showToast("Assigned to " + formatAssignees(assigneeList));
    } catch (e) { console.error(e); showToast("Couldn't assign."); }
  }

  function openCompleteModal(id) {
    const entry = STATE.submissions.find((s) => s.id === id);
    if (!entry) return;
    // Gate: if this entry has a checklist, all items must be checked first.
    if (Array.isArray(entry.checklist) && entry.checklist.length > 0) {
      const remaining = entry.checklist.filter((i) => !i.done).length;
      if (remaining > 0) {
        showToast(`Finish the checklist first — ${remaining} item${remaining === 1 ? "" : "s"} left.`);
        return;
      }
    }

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="done-title">
        <h3 id="done-title">What did you do to fix it?</h3>
        <p><strong>${esc(entry.name)}:</strong> ${esc((entry.problem || "").slice(0, 120))}${(entry.problem || "").length > 120 ? "…" : ""}</p>
        <div class="field">
          <label>Solution <span class="optional">(optional — what actually changed)</span></label>
          <textarea id="done-note" maxlength="500" placeholder="e.g. Added spare trimmer line to every truck on Mondays">${esc(entry.improvedNote || "")}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="d-cancel">Cancel</button>
          <button class="btn" id="d-save" style="width:auto;background:var(--improved);">Mark improved</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector("#d-cancel").addEventListener("click", close);
    backdrop.querySelector("#d-save").addEventListener("click", async () => {
      const note = backdrop.querySelector("#done-note").value.trim();
      close();
      await markImproved(id, note);
    });
    setTimeout(() => backdrop.querySelector("#done-note")?.focus(), 50);
  }

  async function markImproved(id, note) {
    try {
      const { error } = await sb.from("submissions").update({
        status: "improved",
        improved_at: new Date().toISOString(),
        improved_note: note || "",
        improved_by: STATE.name || "Admin",
      }).eq("id", id);
      if (error) throw error;
      showToast("Marked improved ✓");
    } catch (e) { console.error(e); showToast("Couldn't mark improved."); }
  }

  async function undoImproved(id) {
    try {
      const { error } = await sb.from("submissions").update({
        status: "open",
        improved_at: null,
        improved_note: null,
        improved_by: null,
        assigned_to: null,
        assignees: null,
        assigned_by: null,
        assigned_at: null,
        assignment_note: null,
      }).eq("id", id);
      if (error) throw error;
      showToast("Reopened");
    } catch (e) { console.error(e); showToast("Couldn't update."); }
  }

  async function reopen(id) {
    try {
      const { error } = await sb.from("submissions").update({
        status: "open",
        assigned_to: null,
        assignees: null,
        assigned_by: null,
        assigned_at: null,
        assignment_note: null,
      }).eq("id", id);
      if (error) throw error;
      showToast("Back to open");
    } catch (e) { console.error(e); showToast("Couldn't update."); }
  }

  async function deleteEntry(id) {
    const entry = STATE.submissions.find((s) => s.id === id);
    const who = entry ? ` from ${entry.name}` : "";
    const ok = await confirmInline(`Delete this entry${who}? This can't be undone.`);
    if (!ok) return;
    try {
      // Prune reactions & comments first (anon RLS lets us; cascade not set up server-side).
      await sb.from("reactions").delete().eq("entry_id", id);
      await sb.from("comments").delete().eq("entry_id", id);
      const { error } = await sb.from("submissions").delete().eq("id", id);
      if (error) throw error;
      showToast("Deleted");
    } catch (e) { console.error(e); showToast("Couldn't delete."); }
  }

  function confirmInline(message) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h3>Are you sure?</h3>
          <p>${esc(message)}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" id="c-cancel">Cancel</button>
            <button class="btn" id="c-ok" style="width:auto;background:var(--danger);">Delete</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const done = (v) => { backdrop.remove(); resolve(v); };
      backdrop.querySelector("#c-cancel").addEventListener("click", () => done(false));
      backdrop.querySelector("#c-ok").addEventListener("click", () => done(true));
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) done(false); });
    });
  }

  // Opens an entry in a modal overlay — used from the Inbox so tapping an
  // item doesn't throw you out of the inbox entirely. All entry controls
  // (comments, reactions, checklist, assign, complete) work inside the modal.
  // `fromInboxItemId` (optional) lets us offer a "Keep in inbox" action when
  // the modal was opened by tapping an inbox row, so the user can push the
  // item back to unread if they can't deal with it yet.
  function openEntryDetail(entryId, fromInboxItemId) {
    const entry = STATE.submissions.find((s) => s.id === entryId);
    if (!entry) return;
    // Force the comments section open on this view so the composer is right there
    const prevThread = STATE.openCommentThread;
    STATE.openCommentThread = entryId;

    const keepBtn = fromInboxItemId
      ? `<button type="button" class="entry-detail-keep" data-keepid="${esc(fromInboxItemId)}" title="${esc(t("inboxMoveBack"))}">${esc(t("inboxMoveBack"))}</button>`
      : "";

    const el = document.createElement("div");
    el.className = "modal-backdrop entry-detail-backdrop";
    el.innerHTML = `
      <div class="modal entry-detail-modal" role="dialog" aria-modal="true" aria-label="Entry">
        <div class="entry-detail-head">
          <button type="button" class="entry-detail-close" aria-label="${esc(t("inboxBack"))}">${esc(t("inboxBack"))}</button>
          ${keepBtn}
        </div>
        <div class="entry-detail-body">${renderEntry(entry)}</div>
      </div>`;
    document.body.appendChild(el);

    const close = () => {
      STATE.openCommentThread = prevThread;
      STATE._detailModalRerender = null;
      el.remove();
      document.removeEventListener("keydown", onKey);
      // Re-render inbox so any state changes (new comments, reactions) reflect
      render();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    el.querySelector(".entry-detail-close").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });

    const keepButton = el.querySelector(".entry-detail-keep");
    if (keepButton) {
      keepButton.addEventListener("click", () => {
        keepInboxItemUnread(keepButton.dataset.keepid);
        close();
      });
    }

    // Wire all entry actions and the comment composer inside the modal body
    const body = el.querySelector(".entry-detail-body");
    wireEntryActions(body);

    // Realtime updates: when something lands for this entry, re-render the
    // modal body in place (comments, reactions, checklist).
    STATE._detailModalRerender = () => {
      const fresh = STATE.submissions.find((s) => s.id === entryId);
      if (!fresh) { close(); return; }
      body.innerHTML = renderEntry(fresh);
      wireEntryActions(body);
    };
  }

  function openLightbox(src) {
    if (!src) return;
    const el = document.createElement("div");
    el.className = "lightbox";
    el.innerHTML = `<button class="lightbox-close" aria-label="Close">×</button><img src="${esc(src)}" alt="">`;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  function cryptoId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return diffMin + "m ago";
    if (diffHr < 24) return diffHr + "h ago";
    if (diffDay < 7) return diffDay + "d ago";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  let toastTimer = 0;
  function showToast(msg) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
