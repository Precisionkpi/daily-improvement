// Supabase Edge Function: translate-entry
// Translates a batch of short texts between English and Spanish.
// The app passes a language preference and a list of {id, text} items;
// returns {id, text} with translations in the target language.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { items, target } = await req.json();
    if (!Array.isArray(items) || items.length === 0) {
      return json({ error: "items required" }, 400);
    }
    const t = (target === "es" || target === "en") ? target : "es";
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

    const targetName = t === "es" ? "Spanish (Latin American)" : "English";
    const payload = items.map((x: any) => ({
      id: String(x.id ?? ""),
      text: String(x.text ?? ""),
    })).filter((x) => x.text);

    const prompt = `Translate each item's "text" into ${targetName}. Preserve the natural casual tone of a lawn & landscape crew (not formal). If the text is already in ${targetName}, return it unchanged.

Items:
${JSON.stringify(payload)}

Respond with ONLY a JSON array of {"id": "...", "text": "..."} with translations in the target language. No markdown, no prose.`;

    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 4000,
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
      const s = raw.indexOf("["), e = raw.lastIndexOf("]");
      parsed = JSON.parse(raw.slice(s, e + 1));
    } catch (_err) {
      return json({ error: "parse_failed", raw }, 502);
    }

    return json({ target: t, items: parsed });
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
