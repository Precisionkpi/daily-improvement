// Supabase Edge Function: weekly-digest
// Generates (or returns a cached) weekly summary of entries for the current
// business week — Monday through Sunday. Stored in an `insights` table so
// we don't regenerate every time the Insights section opens.

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
    const weekOffset = Number(body?.week_offset ?? 0); // 0 = current, -1 = last week

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { weekStart, weekEnd, weekKey } = weekBounds(weekOffset);

    // Return cached digest if present and not forced.
    if (!force) {
      const { data: cached } = await supabase
        .from("insights").select("*").eq("key", `week:${weekKey}`).maybeSingle();
      if (cached?.body) return json({ cached: true, key: cached.key, ...cached.body });
    }

    const { data: entries } = await supabase
      .from("submissions")
      .select("id,name,headline,problem,solution,impact,status,kind,category,created_at,improved_at")
      .gte("created_at", weekStart.toISOString())
      .lte("created_at", weekEnd.toISOString())
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
        summary: "No entries logged this week yet — the climb is paused.",
        wins: [],
        open: [],
        patterns: [],
        active_people: [],
        week_start: weekStart.toISOString(),
        week_end: weekEnd.toISOString(),
      };
      await supabase.from("insights").upsert({ key: `week:${weekKey}`, body: empty, updated_at: new Date().toISOString() });
      return json(empty);
    }

    const prompt = `You are the operations partner for a lawn & landscape company. Summarize this week's daily improvement log.

Entries (chronological):
${JSON.stringify(list, null, 2)}

Respond with ONLY JSON, no markdown, matching:
{
  "summary": "2-3 sentence plain-English recap for a Monday huddle. Direct, concrete, not corporate.",
  "wins": ["short bullet of a completed improvement", "..."],  // up to 4
  "open": ["short bullet of a still-open issue worth attention", "..."],  // up to 4
  "patterns": ["a pattern worth watching across entries (e.g. 'parking came up 3 times')", "..."],  // up to 3; empty if none
  "active_people": ["Name — N entries", "..."]  // top 3 by entry count
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
        max_tokens: 1200,
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
      summary: String(parsed.summary ?? ""),
      wins: Array.isArray(parsed.wins) ? parsed.wins.slice(0, 6) : [],
      open: Array.isArray(parsed.open) ? parsed.open.slice(0, 6) : [],
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, 4) : [],
      active_people: Array.isArray(parsed.active_people) ? parsed.active_people.slice(0, 5) : [],
      week_start: weekStart.toISOString(),
      week_end: weekEnd.toISOString(),
      entry_count: list.length,
    };
    await supabase.from("insights").upsert({ key: `week:${weekKey}`, body: out, updated_at: new Date().toISOString() });
    return json(out);
  } catch (e) {
    return json({ error: "exception", detail: String(e) }, 500);
  }
});

function weekBounds(offset: number) {
  const now = new Date();
  // Monday-start week; adjust day-of-week so Monday=0, Sunday=6
  const day = (now.getDay() + 6) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - day + (offset * 7));
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  const weekKey = `${weekStart.getFullYear()}-W${String(isoWeekNum(weekStart)).padStart(2, "0")}`;
  return { weekStart, weekEnd, weekKey };
}

function isoWeekNum(d: Date) {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
