

const CHALLENGE_ID = "rolex-001";
const SITE_URL = "https://million-dollar-wall-v2.vercel.app";
const PRICE_CENTS = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_RE = /^cs_live_[A-Za-z0-9]+$/;

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function getPaymentDiagnostics() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  return {
    supabase_url: Boolean(supabaseUrl?.trim()),
    supabase_key: Boolean(supabaseKey?.trim()),
    stripe_live: Boolean(stripeKey?.trim().startsWith("sk_live_"))
  };
}

async function supabaseRpc(name, data) {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error("Configurazione Supabase mancante");
  }

  const response = await fetch(
    `${url}/rest/v1/rpc/${name}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data),
      cache: "no-store"
    }
  );

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${name}: HTTP ${response.status}`
    );
  }

  return raw ? JSON.parse(raw) : null;
}

async function stripeRequest(path, params) {
  const key = process.env.STRIPE_SECRET_KEY?.trim();

  if (!key || !key.startsWith("sk_live_")) {
    throw new Error("Stripe LIVE non configurato");
  }

  const response = await fetch(
    `https://api.stripe.com/v1/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error?.message || "Errore Stripe"
    );
  }

  return result;
}

async function expireSession(sessionId) {
  const key = process.env.STRIPE_SECRET_KEY?.trim();

  await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`
      }
    }
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Metodo non consentito");
  }

  if (process.env.ENABLE_DREAM_PAYMENTS?.trim() !== "true") {
    return sendError(
      res,
      503,
      "Acquisti COLOR MY DREAM non ancora attivi"
    );
  }

  const { x, y, nickname } = req.body || {};

  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x >= 250 ||
    y < 0 ||
    y >= 140
  ) {
    return sendError(res, 400, "Pixel non valido");
  }

  if (
    typeof nickname !== "string" ||
    nickname.trim().length < 1 ||
    nickname.trim().length > 40
  ) {
    return sendError(res, 400, "Nickname non valido");
  }

  const diagnostics = getPaymentDiagnostics();

  if (
    !diagnostics.supabase_url ||
    !diagnostics.supabase_key ||
    !diagnostics.stripe_live
  ) {
    console.error(
      "Dream checkout configuration:",
      diagnostics
    );

    return res.status(503).json({
      error: "Configurazione pagamenti incompleta",
      diagnostics
    });
  }

  let reservationId = null;
  let sessionId = null;
  let sessionAttached = false;

  try {
    reservationId = await supabaseRpc(
      "reserve_dream_pixel",
      {
        p_challenge_id: CHALLENGE_ID,
        p_x: x,
        p_y: y,
        p_nickname: nickname.trim()
      }
    );

    if (
      typeof reservationId !== "string" ||
      !UUID_RE.test(reservationId)
    ) {
      throw new Error("Prenotazione non valida");
    }

    const params = new URLSearchParams({
      mode: "payment",

      success_url:
        `${SITE_URL}/?dream_checkout=success&session_id={CHECKOUT_SESSION_ID}`,

      cancel_url:
        `${SITE_URL}/?dream_checkout=cancel`,

      "line_items[0][price_data][currency]": "eur",
      "line_items[0][price_data][unit_amount]":
        String(PRICE_CENTS),
      "line_items[0][price_data][product_data][name]":
        `COLOR MY DREAM - Rolex pixel (${x}, ${y})`,
      "line_items[0][quantity]": "1",

      "metadata[challenge_id]": CHALLENGE_ID,
      "metadata[reservation_id]": reservationId,
      "metadata[x]": String(x),
      "metadata[y]": String(y),
      "metadata[expected_amount]": String(PRICE_CENTS),

      expires_at:
        String(Math.floor(Date.now() / 1000) + 1800)
    });

    const session = await stripeRequest(
      "checkout/sessions",
      params
    );

    if (
      !SESSION_RE.test(session.id || "") ||
      typeof session.url !== "string"
    ) {
      throw new Error("Sessione Stripe non valida");
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

    sessionAttached = await supabaseRpc(
      "attach_dream_checkout",
      {
        p_reservation_id: reservationId,
        p_stripe_session_id: sessionId
      }
    );

    if (sessionAttached !== true) {
      throw new Error(
        "Impossibile collegare la prenotazione a Stripe"
      );
    }

    return res.status(200).json({
      checkout_url: checkoutUrl.href
    });

  } catch (error) {
    console.error("Dream checkout:", error.message);

    if (sessionId) {
      try {
        await expireSession(sessionId);
      } catch (e) {
        console.error("Scadenza Stripe:", e.message);
      }
    }

    return sendError(
      res,
      502,
      "Impossibile preparare l'acquisto"
    );
  }
}
