

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const { x, y, width, height } = req.body || {};

  const valid = [x, y, width, height].every(
    value => Number.isInteger(value)
  );

  if (
    !valid ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > 1000 ||
    y + height > 1000
  ) {
    return res.status(400).json({
      error: "Coordinate non valide"
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
      `${url}/rest/v1/rpc/check_space_availability`,
      {
        method: "POST",
        headers: {
          apikey: key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_x: x,
          p_y: y,
          p_width: width,
          p_height: height
        })
      }
    );

    if (!response.ok) {
      console.error(
        "Errore Supabase:",
        response.status,
        await response.text()
      );

      return res.status(502).json({
        error: "Impossibile verificare lo spazio"
      });
    }

    const available = await response.json();

    if (typeof available !== "boolean") {
      return res.status(502).json({
        error: "Risposta non valida dal database"
      });
    }

    return res.status(200).json({
      available,
      pixels: width * height,
      price_eur: width * height
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Errore durante il controllo"
    });
  }
}
