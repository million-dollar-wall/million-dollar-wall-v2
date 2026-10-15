
const SITE_URL = "https://million-dollar-wall-v2.vercel.app";

function supabaseHeaders(key) {
  return {
    apikey: key,
    "Content-Type": "application/json"
  };
}

async function callSupabaseRpc(url, key, functionName, data) {
  const response = await fetch(
    `${url}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: supabaseHeaders(key),
      body: JSON.stringify(data)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Supabase ${functionName}: HTTP ${response.status}`
    );
  }

  return response.json();
}

async function expireStripeSession(stripeKey, sessionId) {
  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Impossibile scadere la sessione Stripe: HTTP ${response.status}`
    );
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

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
      error: "Configurazione incompleta"
    });
  }

  let spaceId = null;
  let sessionId = null;
  let sessionAttached = false;

  try {
    // 1. Prenota temporaneamente i pixel.
    spaceId = await callSupabaseRpc(
      supabaseUrl,
      supabaseKey,
      "reserve_wall_space",
      {
        p_x: x,
        p_y: y,
        p_width: width,
        p_height: height,
        p_color: /^#[0-9a-fA-F]{6}$/.test(color || "")
          ? color
          : "#ffffff"
      }
    );

    // 2. Prepara Stripe Checkout.
    const params = new URLSearchParams({
      mode: "payment",

      success_url:
        `${SITE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${SITE_URL}/?checkout=cancel`,

      "line_items[0][price_data][currency]": "eur",

      "line_items[0][price_data][unit_amount]":
        String(amount),

      "line_items[0][price_data][product_data][name]":
        `Spazio pubblicitario ${width} x ${height} pixel`,

      "line_items[0][quantity]": "1",

      "metadata[space_id]": String(spaceId),
      "metadata[pixels]": String(pixels),
      "metadata[expected_amount]": String(amount),

      expires_at:
        String(Math.floor(Date.now() / 1000) + 1800)
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

    if (
      !stripeResponse.ok ||
      !session.id ||
      !session.url ||
      !session.id.startsWith("cs_live_")
    ) {
      console.error(
        "Errore Stripe Checkout:",
        session.error?.message || `HTTP ${stripeResponse.status}`
      );

      throw new Error(
        `Creazione Checkout fallita: HTTP ${stripeResponse.status}`
      );
    }

    sessionId = session.id;

    // 3. Collega Stripe alla prenotazione.
    sessionAttached = await callSupabaseRpc(
      supabaseUrl,
      supabaseKey,
      "attach_wall_checkout",
      {
        p_space_id: spaceId,
        p_stripe_session_id: sessionId
      }
    );

    if (sessionAttached !== true) {
      throw new Error(
        "Collegamento Stripe-Supabase fallito"
      );
    }

    return res.status(200).json({
      checkout_url: session.url
    });

  } catch (error) {
    console.error(
      "Errore create-checkout:",
      error.message
    );

    if (sessionId) {
      try {
        await expireStripeSession(stripeKey, sessionId);
      } catch (expireError) {
        console.error(
          "Errore scadenza sessione:",
          expireError.message
        );
      }
    }

    if (spaceId && !sessionAttached) {
      try {
        await callSupabaseRpc(
          supabaseUrl,
          supabaseKey,
          "cancel_wall_reservation",
          { p_space_id: spaceId }
        );
      } catch (cancelError) {
        console.error(
          "Errore annullamento prenotazione:",
          cancelError.message
        );
      }
    }

    return res.status(502).json({
      error: "Impossibile preparare l'acquisto"
    });
  }
}
