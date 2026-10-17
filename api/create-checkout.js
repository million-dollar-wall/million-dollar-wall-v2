
const SITE_URL = "https://million-dollar-wall-v2.vercel.app";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      body: JSON.stringify(data),
      cache: "no-store"
    }
  );

  const raw = await response.text();

  if (!response.ok) {
    console.error(
      "Supabase RPC fallita:",
      functionName,
      "HTTP",
      response.status
    );

    throw new Error(
      `Supabase ${functionName}: HTTP ${response.status}`
    );
  }

  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    console.error(
      "Supabase RPC: risposta non JSON",
      functionName
    );

    throw new Error(
      `Risposta Supabase non valida: ${functionName}`
    );
  }
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
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  if (process.env.ENABLE_WALL_PAYMENTS !== "true") {
    return res.status(503).json({
      error: "Acquisti temporaneamente disattivati"
    });
  }

  const {
    x,
    y,
    width,
    height,
    color,
    content_type
  } = req.body || {};

  const contentType =
    content_type === undefined ? "color" : content_type;

  if (!["color", "image"].includes(contentType)) {
    return res.status(400).json({
      error: "Tipo di acquisto non valido"
    });
  }

  if (
    contentType === "image" &&
    process.env.ENABLE_IMAGE_UPLOADS !== "true"
  ) {
    return res.status(503).json({
      error: "Acquisto immagini non ancora disponibile"
    });
  }

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

  const selectedColor =
    contentType === "image" ? "#ffffff" : color;

  if (
    typeof selectedColor !== "string" ||
    !/^#[0-9a-fA-F]{6}$/.test(selectedColor)
  ) {
    return res.status(400).json({
      error: "Colore non valido"
    });
  }

  const pixels = width * height;
  const amount = pixels * 100;

  if (
    !Number.isSafeInteger(amount) ||
    amount < 100
  ) {
    return res.status(400).json({
      error: "Importo non valido"
    });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl =
    process.env.SUPABASE_URL?.replace(/\/$/, "");
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
    const reservationResult = await callSupabaseRpc(
      supabaseUrl,
      supabaseKey,
      "reserve_wall_space",
      {
        p_x: x,
        p_y: y,
        p_width: width,
        p_height: height,
        p_color: selectedColor
      }
    );

    if (
      typeof reservationResult !== "string" ||
      !UUID_PATTERN.test(reservationResult)
    ) {
      console.error(
        "Prenotazione non valida:",
        typeof reservationResult
      );

      throw new Error("Prenotazione non valida");
    }

    spaceId = reservationResult;

    const productName =
      contentType === "image"
        ? `Spazio pubblicitario ${width} x ${height}`
        : `Pixel colorati ${width} x ${height}`;

    const params = new URLSearchParams({
      mode: "payment",

      success_url:
        `${SITE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,

      cancel_url:
        `${SITE_URL}/?checkout=cancel`,

      "line_items[0][price_data][currency]":
        "eur",

      "line_items[0][price_data][unit_amount]":
        String(amount),

      "line_items[0][price_data][product_data][name]":
        productName,

      "line_items[0][quantity]":
        "1",

      "metadata[space_id]":
        spaceId,

      "metadata[pixels]":
        String(pixels),

      "metadata[expected_amount]":
        String(amount),

      "metadata[content_type]":
        contentType,

      expires_at:
        String(Math.floor(Date.now() / 1000) + 1800)
    });

    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );

    const session = await stripeResponse.json();

    if (
      !stripeResponse.ok ||
      typeof session.id !== "string" ||
      !session.id.startsWith("cs_live_") ||
      typeof session.url !== "string"
    ) {
      console.error(
        "Errore Stripe:",
        session.error?.message ||
        stripeResponse.status
      );

      throw new Error("Creazione Checkout fallita");
    }

    const checkoutUrl = new URL(session.url);

    if (
      checkoutUrl.protocol !== "https:" ||
      ![
        "checkout.stripe.com",
        "pay.stripe.com"
      ].includes(checkoutUrl.hostname)
    ) {
      throw new Error("URL Checkout non valido");
    }

    sessionId = session.id;

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
      checkout_url: checkoutUrl.href
    });

  } catch (error) {
    console.error(
      "Errore create-checkout:",
      error.message
    );

    if (sessionId) {
      try {
        await expireStripeSession(
          stripeKey,
          sessionId
        );
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
          {
            p_space_id: spaceId
          }
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
