// Supabase Edge Function: generate-headline
// Called after a submission is created. One Claude call returns:
//   - headline  (4-8 word title)
//   - category  (one of the fixed set)
//   - kind      ("difficult" or "impact")
//   - related   (array of submission ids this likely relates to)
// All fields are written back to the submission row.
//
// Env: ANTHROPIC_API_KEY, plus the injected SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORIES = [
  "equipment", "scheduling", "materials", "customer", "sales",
  "safety", "process", "training", "other",
];
const KINDS = ["difficult", "impact"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { submission_id, problem, solution, impact } = await req.json();
    if (!submission_id || !problem) {
      return json({ error: "submission_id and problem required" }, 400);
    }
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Fetch last 30 entries (excluding this one) as context for related-entry detection.
    const { data: prior } = await supabase
      .from("submissions")
      .select("id,headline,problem,category,created_at")
      .neq("id", submission_id)
      .order("created_at", { ascending: false })
      .limit(30);

    const priorLines = (prior ?? []).map((p, i) =>
      `${i + 1}. [${p.id}] (${p.category ?? "other"}) ${p.headline ?? p.problem.slice(0, 80)}`
    ).join("\n");

    const parts = [`Problem: ${problem}`];
    if (solution) parts.push(`Solution: ${solution}`);
    if (impact) parts.push(`Impact: ${impact}`);
    const body = parts.join("\n");

    const prompt = `You help a lawn & landscape company triage their daily improvement log entries. The crew is bilingual; some dictate in English, some in Spanish.

New entry (as submitted, in the speaker's language):
${body}

Recent entries (for finding related ones):
${priorLines || "(none)"}

Respond with ONLY a JSON object (no markdown, no prose) with these keys:
{
  "source_lang": "en" or "es",   // language of the entry as submitted
  "category": "one of: ${CATEGORIES.join(", ")}",
  "kind": "one of: difficult (a problem/issue) or impact (a win/improvement)",
  "related_ids": ["id1", "id2"],  // 0-3 ids from the recent entries that cover the SAME underlying issue, not just the same topic. Empty array if nothing close.
  "en": {
    "headline": "4-8 word English title, Title Case, no quotes, no period",
    "problem":  "the problem text in English",
    "solution": "the solution text in English (empty string if none was submitted)",
    "impact":   "the impact text in English (empty string if none was submitted)"
  },
  "es": {
    "headline": "titular en español de 4-8 palabras, Mayúscula Inicial, sin comillas, sin punto final",
    "problem":  "el problema en español",
    "solution": "la solución en español (cadena vacía si no se envió ninguna)",
    "impact":   "el impacto en español (cadena vacía si no se envió ninguno)"
  }
}

Translation rules:
- The source-language version should be the user's own wording (verbatim, only filler removed).
- The other-language version should be a natural translation that preserves the casual crew tone — not formal, not corporate.
- If a solution/impact wasn't submitted, use empty strings for BOTH languages.`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errTxt = await anthropicRes.text();
      return json({ error: "anthropic_error", status: anthropicRes.status, detail: errTxt }, 502);
    }

    const data = await anthropicRes.json();
    const raw = (data?.content?.[0]?.text ?? "").trim();
    let parsed: any;
    try {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch (_e) {
      return json({ error: "parse_failed", raw }, 502);
    }

    const sourceLang = parsed.source_lang === "es" ? "es" : "en";
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : "other";
    const kind = KINDS.includes(parsed.kind) ? parsed.kind : "difficult";
    const priorIds = new Set((prior ?? []).map((p) => p.id));
    const related = Array.isArray(parsed.related_ids)
      ? parsed.related_ids.filter((x: any) => typeof x === "string" && priorIds.has(x)).slice(0, 3)
      : [];

    const cleanLang = (o: any) => ({
      headline: String(o?.headline ?? "").replace(/^"|"$/g, "").replace(/\.+$/, "").trim(),
      problem:  String(o?.problem  ?? "").trim(),
      solution: String(o?.solution ?? "").trim(),
      impact:   String(o?.impact   ?? "").trim(),
    });
    const translations = {
      en: cleanLang(parsed.en),
      es: cleanLang(parsed.es),
    };
    // The "canonical" headline column gets the English one — it's what shows in
    // notifications, the fallback renderer, and is more universally searchable.
    const headline = translations.en.headline || translations.es.headline || "";

    const update: Record<string, unknown> = {
      category, kind,
      source_lang: sourceLang,
      translations,
    };
    if (headline) update.headline = headline;
    if (related.length) update.related_to = related;

    const { error: updErr } = await supabase
      .from("submissions").update(update).eq("id", submission_id);
    if (updErr) return json({ error: "db_update_failed", detail: updErr.message }, 500);

    return json({ submission_id, headline, category, kind, related, source_lang: sourceLang, translations });
  } catch (e) {
    return json({ error: "exception", detail: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
