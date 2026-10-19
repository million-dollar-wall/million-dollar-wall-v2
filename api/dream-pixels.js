
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const supabaseUrl = (
    process.env.SUPABASE_URL || ""
  ).replace(/\/$/, "");

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!supabaseUrl || !serviceKey) {
    console.error(
      "Configurazione Supabase mancante"
    );

    return res.status(503).json({
      error: "Servizio temporaneamente non disponibile"
    });
  }

  try {
    const url =
      supabaseUrl +
      "/rest/v1/rpc/get_dream_sold_pixels";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_challenge_id: "rolex-001"
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.error(
        "Errore Supabase:",
        response.status
      );

      return res.status(502).json({
        error: "Impossibile caricare i pixel"
      });
    }

    const pixels = await response.json();

    if (!Array.isArray(pixels)) {
      return res.status(502).json({
        error: "Risposta database non valida"
      });
    }

    return res.status(200).json({
      challenge_id: "rolex-001",
      pixels: pixels.map(pixel => ({
        x: pixel.x,
        y: pixel.y,
        nickname: pixel.nickname
      }))
    });

  } catch (error) {
    console.error(
      "Errore caricamento pixel:",
      error.message
    );

    return res.status(502).json({
      error: "Errore di connessione al database"
    });
  }
}
