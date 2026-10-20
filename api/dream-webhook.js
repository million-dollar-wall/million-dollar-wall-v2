
import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

const CHALLENGE_ID = "rolex-001";
const PRICE_CENTS = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_RE = /^cs_live_[A-Za-z0-9]+$/;

function verifySignature(payload, header, secret) {
  if (
    typeof header !== "string" ||
    !secret
  ) {
    return false;
  }

  const parts = header.split(",").map(p => p.trim());

  const timestamp = parts
    .find(p => p.startsWith("t="))
    ?.slice(2);

  const signatures = parts
    .filter(p => p.startsWith("v1="))
    .map(p => p.slice(3));

  if (
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    signatures.length === 0
  ) {
    return false;
  }

  const time = Number(timestamp);

  if (
    !Number.isSafeInteger(time) ||
    Math.abs(Date.now() / 1000 - time) > 300
  ) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();

  return signatures.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) {
      return false;
    }

    return crypto.timingSafeEqual(
      expected,
      Buffer.from(signature, "hex")
    );
  });
}

async function readBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    total += buffer.length;

    if (total > 1024 * 1024) {
      throw new Error("Payload troppo grande");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function supabaseRequest(path, options = {}) {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase non configurato");
  }

  const response = await fetch(
    `${url}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      cache: "no-store"
    }
  );

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}`
    );
  }

  return raw ? JSON.parse(raw) : null;
}

async function supabaseRpc(name, data) {
  return supabaseRequest(`rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(data)
  });
}

async function getReservation(id) {
  const rows = await supabaseRequest(
    "dream_pixels?id=eq." +
      encodeURIComponent(id) +
      "&select=id,challenge_id,x,y,status,stripe_session_id,payment_amount_cents"
  );

  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Prenotazione non trovata");
  }

  return rows[0];
}

async function retrieveStripeSession(sessionId) {
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key?.startsWith("sk_live_")) {
    throw new Error("Stripe LIVE non configurato");
  }

  const response = await fetch(
    "https://api.stripe.com/v1/checkout/sessions/" +
      encodeURIComponent(sessionId),
    {
      headers: {
        Authorization: `Bearer ${key}`
      },
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(
      `Stripe HTTP ${response.status}`
    );
  }

  return response.json();
}

async function confirmPayment(eventSession) {
  const sessionId = eventSession?.id;

  if (
    typeof sessionId !== "string" ||
    !SESSION_RE.test(sessionId)
  ) {
    throw new Error("Sessione non valida");
  }

  // Recuperiamo la sessione direttamente da Stripe.
  const session = await retrieveStripeSession(sessionId);

  if (
    session.id !== sessionId ||
    session.livemode !== true ||
    session.mode !== "payment" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.currency?.toLowerCase() !== "eur" ||
    session.amount_total !== PRICE_CENTS ||
    session.amount_subtotal !== PRICE_CENTS ||
    session.metadata?.challenge_id !== CHALLENGE_ID ||
    session.metadata?.expected_amount !==
      String(PRICE_CENTS)
  ) {
    throw new Error("Pagamento non valido");
  }

  const reservationId =
    session.metadata?.reservation_id;

  if (
    typeof reservationId !== "string" ||
    !UUID_RE.test(reservationId)
  ) {
    throw new Error("ID prenotazione non valido");
  }

  const reservation =
    await getReservation(reservationId);

  if (
    reservation.challenge_id !== CHALLENGE_ID ||
    reservation.stripe_session_id !== sessionId ||
    reservation.payment_amount_cents !== PRICE_CENTS ||
    String(reservation.x) !== session.metadata?.x ||
    String(reservation.y) !== session.metadata?.y
  ) {
    throw new Error(
      "Prenotazione e pagamento non corrispondono"
    );
  }

  const confirmed = await supabaseRpc(
    "confirm_dream_payment",
    {
      p_reservation_id: reservationId,
      p_stripe_session_id: sessionId
    }
  );

  if (confirmed !== true) {
    throw new Error(
      "Impossibile confermare il pixel"
    );
  }

  console.log(
    "COLOR MY DREAM: pixel venduto",
    reservation.x,
    reservation.y
  );
}

async function releaseExpired(eventSession) {
  const sessionId = eventSession?.id;

  if (
    typeof sessionId !== "string" ||
    !SESSION_RE.test(sessionId)
  ) {
    throw new Error("Sessione non valida");
  }

  const session = await retrieveStripeSession(sessionId);

  if (
    session.id !== sessionId ||
    session.livemode !== true ||
    session.status !== "expired" ||
    session.payment_status === "paid" ||
    session.metadata?.challenge_id !== CHALLENGE_ID
  ) {
    throw new Error("Sessione scaduta non valida");
  }

  const reservationId =
    session.metadata?.reservation_id;

  if (
    typeof reservationId !== "string" ||
    !UUID_RE.test(reservationId)
  ) {
    throw new Error("Prenotazione non valida");
  }

  const reservation =
    await getReservation(reservationId);

  if (
    reservation.status === "sold"
  ) {
    return;
  }

  if (
    reservation.stripe_session_id !== sessionId ||
    reservation.challenge_id !== CHALLENGE_ID
  ) {
    throw new Error(
      "Prenotazione non corrispondente"
    );
  }

  await supabaseRpc(
    "release_expired_dream_checkout",
    {
      p_reservation_id: reservationId,
      p_stripe_session_id: sessionId
    }
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const webhookSecret =
    process.env.STRIPE_DREAM_WEBHOOK_SECRET;

  if (
    !webhookSecret ||
    !process.env.STRIPE_SECRET_KEY ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return res.status(503).json({
      error: "Configurazione incompleta"
    });
  }

  let payload;

  try {
    payload = await readBody(req);
  } catch {
    return res.status(413).json({
      error: "Payload non valido"
    });
  }

  if (
    !verifySignature(
      payload,
      req.headers["stripe-signature"],
      webhookSecret
    )
  ) {
    return res.status(400).json({
      error: "Firma Stripe non valida"
    });
  }

  let event;

  try {
    event = JSON.parse(
      payload.toString("utf8")
    );
  } catch {
    return res.status(400).json({
      error: "JSON non valido"
    });
  }

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await confirmPayment(event.data?.object);
    }

    if (event.type === "checkout.session.expired") {
      await releaseExpired(event.data?.object);
    }

    return res.status(200).json({
      received: true
    });

  } catch (error) {
    console.error(
      "Dream webhook:",
      error.message
    );

    return res.status(500).json({
      error: "Evento non elaborato"
    });
  }
}
