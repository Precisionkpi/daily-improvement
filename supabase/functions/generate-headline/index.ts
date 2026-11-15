// Supabase Edge Function: generate-headline
// Called by the app (and by a backfill script) after a submission is created.
// Calls Anthropic Claude to produce a 4-8 word headline, then writes it back.
//
// Env vars required (set under Supabase Dashboard -> Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY   - the user-scoped sk-ant-usr-... key from console.anthropic.com
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { submission_id, problem, solution, impact } = await req.json();
    if (!submission_id || !problem) {
      return new Response(JSON.stringify({ error: "submission_id and problem required" }), {
        status: 400,
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), {
        status: 500,
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    const parts = [`Problem: ${problem}`];
    if (solution) parts.push(`Solution: ${solution}`);
    if (impact) parts.push(`Impact: ${impact}`);
    const body = parts.join("\n");

    const prompt = `You write short, punchy headlines for a lawn & landscape company's daily improvement log. Given the entry below, write ONE headline of 4-8 words that captures the core issue. Use title case. No quotes, no trailing period, no emoji.\n\n${body}`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 60,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errTxt = await anthropicRes.text();
      return new Response(
        JSON.stringify({ error: "anthropic_error", status: anthropicRes.status, detail: errTxt }),
        { status: 502, headers: { ...CORS, "content-type": "application/json" } },
      );
    }

    const data = await anthropicRes.json();
    let headline = (data?.content?.[0]?.text ?? "").trim();
    headline = headline.replace(/^"|"$/g, "").replace(/\.+$/, "").trim();
    if (!headline) {
      return new Response(JSON.stringify({ error: "empty_headline" }), {
        status: 502,
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error: updErr } = await supabase
      .from("submissions")
      .update({ headline })
      .eq("id", submission_id);

    if (updErr) {
      return new Response(JSON.stringify({ error: "db_update_failed", detail: updErr.message }), {
        status: 500,
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ submission_id, headline }), {
      headers: { ...CORS, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "exception", detail: String(e) }), {
      status: 500,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }
});
