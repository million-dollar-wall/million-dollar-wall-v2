
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
    const query = new URLSearchParams({
      select: "id",
      status: "in.(reserved,sold)",
      x: `lt.${x + width}`,
      y: `lt.${y + height}`,
      "x+width": ""
    });

    // Recuperiamo gli spazi occupati e
    // controlliamo le intersezioni sul server.
    const response = await fetch(
      `${url}/rest/v1/wall_spaces?select=id,x,y,width,height&status=in.(reserved,sold)&x=lt.${x + width}&y=lt.${y + height}`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`
        }
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        error: "Impossibile verificare lo spazio"
      });
    }

    const spaces = await response.json();

    const occupied = spaces.some(space =>
      space.x + space.width > x &&
      space.y + space.height > y
    );

    return res.status(200).json({
      available: !occupied,
      pixels: width * height,
      price_eur: width * height
    });

  } catch (error) {
    return res.status(500).json({
      error: "Errore durante il controllo"
    });
  }
}
