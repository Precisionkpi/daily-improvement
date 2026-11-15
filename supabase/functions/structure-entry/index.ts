// Supabase Edge Function: structure-entry
// Takes a raw transcript (typed or voice-dictated) and splits it into
// problem / solution / impact. Used by the voice-to-entry button so the
// crew can just talk and the form auto-fills.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { transcript } = await req.json();
    if (!transcript || typeof transcript !== "string") {
      return json({ error: "transcript required" }, 400);
    }
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

    const prompt = `A crew member at a lawn & landscape company dictated this entry into the daily improvement log:

"""
${transcript}
"""

Extract the parts into JSON. Fields:
- "problem": the issue they ran into (what made the day harder). Clean it up grammatically but keep their voice. Required.
- "solution": what they did about it, if they mention one. Empty string if they didn't.
- "impact": the result or why it matters, if they mention one. Empty string if they didn't.
- "kind": "impact" if this is a win/improvement they already made, or "difficult" if this is still a problem.

Respond with ONLY a JSON object, no markdown fences, no prose.`;

    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 500,
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

    return json({
      problem:  String(parsed.problem  ?? "").trim(),
      solution: String(parsed.solution ?? "").trim(),
      impact:   String(parsed.impact   ?? "").trim(),
      kind:     parsed.kind === "impact" ? "impact" : "difficult",
    });
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
