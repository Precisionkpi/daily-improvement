// Supabase Edge Function: monthly-report
// Generates a formal month-end summary of operational improvements —
// something Ben can show to leadership / his accountant / his advisor.
// Cached in the `insights` table under key "month:YYYY-MM".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const force = Boolean(body?.force);
    const monthOffset = Number(body?.month_offset ?? 0); // 0=current, -1=last month

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { monthStart, monthEnd, monthKey, monthLabel } = monthBounds(monthOffset);

    if (!force) {
      const { data: cached } = await supabase
        .from("insights").select("*").eq("key", `month:${monthKey}`).maybeSingle();
      if (cached?.body) return json({ cached: true, key: cached.key, ...cached.body });
    }

    const { data: entries } = await supabase
      .from("submissions")
      .select("id,name,headline,problem,solution,impact,status,kind,category,created_at,improved_at")
      .gte("created_at", monthStart.toISOString())
      .lte("created_at", monthEnd.toISOString())
      .order("created_at", { ascending: true });

    const list = (entries ?? []).map((e) => ({
      by: e.name,
      status: e.status,
      kind: e.kind,
      category: e.category,
      title: e.headline || e.problem.slice(0, 100),
      details: `${e.problem}${e.solution ? `  Solution: ${e.solution}` : ""}${e.impact ? `  Impact: ${e.impact}` : ""}`,
    }));

    if (list.length === 0) {
      const empty = {
        month: monthLabel,
        exec_summary: "No entries logged this month.",
        improvements: [],
        open_initiatives: [],
        themes: [],
        by_category: {},
        entry_count: 0,
        month_start: monthStart.toISOString(),
        month_end: monthEnd.toISOString(),
      };
      await supabase.from("insights").upsert({ key: `month:${monthKey}`, body: empty, updated_at: new Date().toISOString() });
      return json(empty);
    }

    const prompt = `You are writing a one-page operational-improvement report for the owner of a lawn & landscape company. Audience: owner, possibly shared with accountant/advisor. Tone: plain, confident, factual — not corporate jargon.

Month: ${monthLabel}
Entries (${list.length}):
${JSON.stringify(list, null, 2)}

Respond with ONLY JSON, no markdown:
{
  "exec_summary": "3-5 sentence paragraph recapping the month's operational improvements and their business impact.",
  "improvements": [
    {"title": "short name", "detail": "1-2 sentence description of what was fixed and the benefit"}
  ],  // up to 6 strongest
  "open_initiatives": [
    {"title": "...", "detail": "..."}
  ],  // up to 4 things still in motion
  "themes": ["recurring area of focus 1", "..."],  // 2-4
  "by_category": {"equipment": N, "scheduling": N, ...}  // count per category present
}`;

    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!ar.ok) {
      const errTxt = await ar.text();
      return json({ error: "anthropic_error", status: ar.status, detail: errTxt }, 502);
    }

    const data = await ar.json();
    const raw = (data?.content?.[0]?.text ?? "").trim();
    let parsed: any;
    try {
      const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
      parsed = JSON.parse(raw.slice(s, e + 1));
    } catch (_err) {
      return json({ error: "parse_failed", raw }, 502);
    }

    const out = {
      month: monthLabel,
      exec_summary: String(parsed.exec_summary ?? ""),
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 8) : [],
      open_initiatives: Array.isArray(parsed.open_initiatives) ? parsed.open_initiatives.slice(0, 6) : [],
      themes: Array.isArray(parsed.themes) ? parsed.themes.slice(0, 5) : [],
      by_category: typeof parsed.by_category === "object" && parsed.by_category ? parsed.by_category : {},
      entry_count: list.length,
      month_start: monthStart.toISOString(),
      month_end: monthEnd.toISOString(),
    };
    await supabase.from("insights").upsert({ key: `month:${monthKey}`, body: out, updated_at: new Date().toISOString() });
    return json(out);
  } catch (e) {
    return json({ error: "exception", detail: String(e) }, 500);
  }
});

function monthBounds(offset: number) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 23, 59, 59, 999);
  const monthKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  const monthLabel = start.toLocaleString("en-US", { month: "long", year: "numeric" });
  return { monthStart: start, monthEnd: end, monthKey, monthLabel };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
