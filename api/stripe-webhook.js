
import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

function verifySignature(payload, header, secret) {
  if (
    typeof header !== "string" ||
    !secret ||
    !header.includes("v1=")
  ) {
    return false;
  }

  const parts = header.split(",");
  const timestamp = parts
    .find(p => p.startsWith("t="))
    ?.slice(2);

  const signatures = parts
    .filter(p => p.startsWith("v1="))
    .map(p => p.slice(3));

  if (!timestamp || !/^\d+$/.test(timestamp)) {
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
  let size = 0;

  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    size += data.length;

    if (size > 1024 * 1024) {
      throw new Error("Payload troppo grande");
    }

    chunks.push(data);
  }

  return Buffer.concat(chunks);
}

async function supabaseRequest(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Configurazione Supabase mancante");
  }

  const response = await fetch(
    `${url}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: key,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
}

async function confirmPayment(session) {
  if (
    !session ||
    typeof session.id !== "string" ||
    !session.id.startsWith("cs_live_") ||
    session.mode !== "payment" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.currency?.toLowerCase() !== "eur"
  ) {
    throw new Error("Sessione Stripe non valida");
  }

  const spaceId = session.metadata?.space_id;

  if (
    typeof spaceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spaceId)
  ) {
    throw new Error("Identificativo spazio non valido");
  }

  const rows = await supabaseRequest(
    `wall_spaces?id=eq.${encodeURIComponent(spaceId)}` +
    "&select=id,width,height,status,stripe_session_id"
  );

  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Prenotazione non trovata");
  }

  const space = rows[0];
  const expectedAmount = space.width * space.height * 100;

  if (
    !Number.isSafeInteger(expectedAmount) ||
    expectedAmount < 100 ||
    session.amount_total !== expectedAmount ||
    space.stripe_session_id !== session.id ||
    session.metadata?.expected_amount !== String(expectedAmount) ||
    session.metadata?.pixels !== String(space.width * space.height)
  ) {
    throw new Error("Dati o importo del pagamento non corrispondenti");
  }

  const confirmed = await supabaseRequest(
    "rpc/confirm_wall_payment",
    {
      method: "POST",
      body: JSON.stringify({
        p_space_id: spaceId,
        p_stripe_session_id: session.id
      })
    }
  );

  if (confirmed !== true) {
    throw new Error(
      "Pagamento ricevuto, ma prenotazione non confermabile"
    );
  }

  console.log("Acquisto confermato:", session.id);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  if (
    !process.env.STRIPE_WEBHOOK_SECRET ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SECRET_KEY
  ) {
    return res.status(503).json({
      error: "Configurazione webhook incompleta"
    });
  }

  let payload;

  try {
    payload = await readBody(req);
  } catch (error) {
    return res.status(413).json({
      error: "Payload non valido"
    });
  }

  if (
    !verifySignature(
      payload,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    )
  ) {
    return res.status(400).json({
      error: "Firma Stripe non valida"
    });
  }

  let event;

  try {
    event = JSON.parse(payload.toString("utf8"));
  } catch {
    return res.status(400).json({
      error: "JSON non valido"
    });
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({
      received: true
    });
  }

  try {
    await confirmPayment(event.data?.object);

    return res.status(200).json({
      received: true,
      confirmed: true
    });
  } catch (error) {
    console.error(
      "Conferma pagamento fallita:",
      error.message
    );

    // Stripe potrà ritentare la consegna.
    return res.status(500).json({
      error: "Conferma acquisto non riuscita"
    });
  }
}
