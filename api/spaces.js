

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    return res.status(503).json({
      error: "Configurazione Supabase mancante"
    });
  }

  try {
    // Mostra soltanto gli spazi venduti
    // e approvati dall'amministratore.
    const params = new URLSearchParams({
      status: "eq.sold",
      approval_status: "eq.approved",
      select: "id,x,y,width,height,image_url,link_url,color",
      order: "created_at.asc",
      limit: "1000"
    });

    const response = await fetch(
      `${url}/rest/v1/wall_spaces?${params}`,
      {
        headers: {
          apikey: key,
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (!response.ok) {
      console.error(
        "Public spaces fetch failed:",
        response.status
      );

      return res.status(502).json({
        error: "Errore nella lettura degli spazi"
      });
    }

    const spaces = await response.json();

    if (!Array.isArray(spaces)) {
      return res.status(502).json({
        error: "Risposta database non valida"
      });
    }

    return res.status(200).json({
      spaces
    });

  } catch (error) {
    console.error("Spaces API error:", error.message);

    return res.status(500).json({
      error: "Impossibile contattare Supabase"
    });
  }
}
