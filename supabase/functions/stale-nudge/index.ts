// Supabase Edge Function: stale-nudge
// Finds entries that are "in progress" (assigned) with no update for N days
// and posts a short Claude-written nudge as a comment, attributed to "Claude".
// We also record a row in the `nudges` table so we never nudge the same entry
// more than once per 5 days.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const STALE_DAYS = 5;
const COOLDOWN_DAYS = 5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - STALE_DAYS);

    // Pull open/assigned entries older than cutoff
    const { data: stale, error: staleErr } = await supabase
      .from("submissions")
      .select("id,name,headline,problem,assignees,assigned_to,status,created_at")
      .in("status", ["open", "assigned"])
      .lt("created_at", cutoff.toISOString())
      .order("created_at", { ascending: true })
      .limit(20);
    if (staleErr) return json({ error: "db_read_failed", detail: staleErr.message }, 500);

    const nudged: string[] = [];
    for (const entry of (stale ?? [])) {
      // Check cooldown
      const { data: recent } = await supabase
        .from("nudges").select("id,created_at").eq("entry_id", entry.id)
        .gte("created_at", new Date(Date.now() - COOLDOWN_DAYS * 86400000).toISOString())
        .limit(1);
      if (recent && recent.length > 0) continue;

      // Ensure nothing posted on this entry in the last COOLDOWN_DAYS days either
      const { data: recentUpdate } = await supabase
        .from("updates").select("id").eq("entry_id", entry.id)
        .gte("created_at", new Date(Date.now() - COOLDOWN_DAYS * 86400000).toISOString())
        .limit(1);
      if (recentUpdate && recentUpdate.length > 0) continue;

      const assignees = Array.isArray(entry.assignees) && entry.assignees.length > 0
        ? entry.assignees
        : (entry.assigned_to ? [entry.assigned_to] : []);
      const who = assignees[0] || entry.name;
      const firstName = String(who).split(" ")[0];

      const prompt = `Write a VERY SHORT (max 20 words) friendly nudge comment for an operations improvement log.
Entry title: "${entry.headline || entry.problem.slice(0, 80)}"
Assigned to: ${firstName}
It has been ${STALE_DAYS}+ days with no update.

Write as if you are a helpful teammate checking in. One sentence. No greeting ("Hey ..." is fine). No hashtags. No emoji at the start.`;

      const ar = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 80,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!ar.ok) continue;
      const data = await ar.json();
      const text = (data?.content?.[0]?.text ?? "").trim().replace(/^"|"$/g, "");
      if (!text) continue;

      // Post as a comment, attributed to "Claude"
      const commentId = `nudge-${entry.id}-${Date.now()}`;
      const { error: cErr } = await supabase.from("comments").insert([{
        id: commentId,
        entry_id: entry.id,
        author: "Claude",
        text,
      }]);
      if (cErr) continue;

      await supabase.from("nudges").insert([{
        id: `${entry.id}-${Date.now()}`,
        entry_id: entry.id,
        comment_id: commentId,
      }]);
      nudged.push(entry.id);
    }

    return json({ nudged_count: nudged.length, nudged });
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
