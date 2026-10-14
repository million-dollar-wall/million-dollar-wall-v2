
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    return res.status(500).json({
      error: "Configurazione Supabase mancante"
    });
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/wall_spaces?status=eq.sold&select=id,x,y,width,height,image_url,link_url,color&order=created_at.asc&limit=1000`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`
        }
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        error: "Errore nella lettura degli spazi"
      });
    }

    const spaces = await response.json();

    return res.status(200).json({
      spaces
    });

  } catch (error) {
    return res.status(500).json({
      error: "Impossibile contattare Supabase"
    });
  }
}
