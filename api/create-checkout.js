
export default async function handler(req, res) {
  // Sicurezza: acquisti disattivati fino al completamento dei test.
  if (process.env.ENABLE_WALL_PAYMENTS !== "true") {
    return res.status(503).json({
      error: "Acquisti temporaneamente disattivati"
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const { x, y, width, height, color } = req.body || {};

  if (
    ![x, y, width, height].every(Number.isInteger) ||
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

  const pixels = width * height;
  const amount = pixels * 100;

  // Il prezzo è calcolato dal server: 1 euro per pixel.
  if (!Number.isSafeInteger(amount) || amount < 100) {
    return res.status(400).json({
      error: "Importo non valido"
    });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!stripeKey || !supabaseUrl || !supabaseKey) {
    return res.status(503).json({
      error: "Configurazione pagamenti incompleta"
    });
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  try {
    // 1. Prenota i pixel nel database.
    const reservationResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/reserve_wall_space`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_x: x,
          p_y: y,
          p_width: width,
          p_height: height,
          p_color: /^#[0-9a-fA-F]{6}$/.test(color || "")
            ? color
            : "#ffffff"
        })
      }
    );

    if (!reservationResponse.ok) {
      return res.status(409).json({
        error: "Pixel non disponibili o prenotazione non riuscita"
      });
    }

    const spaceId = await reservationResponse.json();

    // 2. Crea la sessione Stripe.
    const origin = "https://million-dollar-wall-v2.vercel.app";

    const params = new URLSearchParams({
      mode: "payment",
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`,
      "line_items[0][price_data][currency]": "eur",
      "line_items[0][price_data][unit_amount]": String(amount),
      "line_items[0][price_data][product_data][name]":
        `Spazio pubblicitario ${width} x ${height} pixel`,
      "line_items[0][quantity]": "1",
      "metadata[space_id]": String(spaceId),
      "metadata[pixels]": String(pixels),
      "metadata[expected_amount]": String(amount),
      "payment_method_types[0]": "card",
      expires_at: String(Math.floor(Date.now() / 1000) + 1800)
    });

    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );

    const session = await stripeResponse.json();

    if (!stripeResponse.ok || !session.id || !session.url) {
      console.error("Creazione Checkout fallita", stripeResponse.status);
      return res.status(502).json({
        error: "Impossibile creare il Checkout"
      });
    }

    // 3. Collega la sessione Stripe alla prenotazione.
    const attachResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/attach_wall_checkout`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_space_id: spaceId,
          p_stripe_session_id: session.id
        })
      }
    );

    const attached = attachResponse.ok
      ? await attachResponse.json()
      : false;

    if (attached !== true) {
      // Non restituiamo un Checkout non collegato al database.
      console.error("Collegamento Checkout fallito");
      return res.status(502).json({
        error: "Impossibile collegare il pagamento alla prenotazione"
      });
    }

    return res.status(200).json({
      checkout_url: session.url
    });

  } catch (error) {
    console.error("Errore create-checkout:", error);
    return res.status(500).json({
      error: "Errore durante la preparazione dell'acquisto"
    });
  }
}
