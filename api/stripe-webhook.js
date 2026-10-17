

import crypto from "node:crypto";

export const config = {
  api: { bodyParser: false }
};

const ALLOWED_PRICES_CENTS = [50, 100];

function verifySignature(payload, header, secret) {
  if (typeof header !== "string" || !secret) return false;

  const parts = header.split(",").map(p => p.trim());
  const timestamp = parts.find(p => p.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter(p => p.startsWith("v1="))
    .map(p => p.slice(3));

  if (!timestamp || !/^\d+$/.test(timestamp)) return false;

  const time = Number(timestamp);

  if (!Number.isSafeInteger(time)) return false;
  if (Math.abs(Date.now() / 1000 - time) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();

  return signatures.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;

    return crypto.timingSafeEqual(
      expected,
      Buffer.from(signature, "hex")
    );
  });
}

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;

  if (typeof req.body === "string") {
    return Buffer.from(req.body, "utf8");
  }

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
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Configurazione Supabase mancante");
  }

  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase HTTP ${response.status}`);
  }

  return response.json();
}

function getSpaceId(session) {
  const id = session?.metadata?.space_id;

  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new Error("ID spazio non valido");
  }

  return id;
}

async function getSpace(spaceId) {
  const rows = await supabaseRequest(
    `wall_spaces?id=eq.${encodeURIComponent(spaceId)}` +
    "&select=id,width,height,status,stripe_session_id,approval_status,image_path"
  );

  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Spazio non trovato");
  }

  return rows[0];
}

async function approveColorSpace(spaceId, sessionId) {
  const params = new URLSearchParams({
    id: `eq.${spaceId}`,
    status: "eq.sold",
    stripe_session_id: `eq.${sessionId}`,
    approval_status: "eq.pending_review",
    image_path: "is.null",
    select: "id"
  });

  const updated = await supabaseRequest(
    `wall_spaces?${params}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        approval_status: "approved",
        reviewed_at: new Date().toISOString()
      })
    }
  );

  if (Array.isArray(updated) && updated.length === 1) {
    console.log("Pixel colorati pubblicati:", spaceId);
    return;
  }

  const space = await getSpace(spaceId);

  if (
    space.status === "sold" &&
    space.stripe_session_id === sessionId &&
    space.approval_status === "approved" &&
    !space.image_path
  ) {
    return;
  }

  throw new Error(
    "Impossibile pubblicare automaticamente lo spazio"
  );
}

async function confirmPayment(session) {
  if (
    !session ||
    session.livemode !== true ||
    typeof session.id !== "string" ||
    !session.id.startsWith("cs_live_") ||
    session.mode !== "payment" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.currency?.toLowerCase() !== "eur"
  ) {
    throw new Error("Sessione di pagamento non valida");
  }

  const spaceId = getSpaceId(session);
  const space = await getSpace(spaceId);

  const pixels = space.width * space.height;
  const paidAmount = session.amount_total;
  const unitPrice = paidAmount / pixels;

  if (
    !Number.isSafeInteger(pixels) ||
    pixels < 1 ||
    !ALLOWED_PRICES_CENTS.includes(unitPrice) ||
    session.amount_subtotal !== paidAmount ||
    space.stripe_session_id !== session.id ||
    session.metadata?.pixels !== String(pixels) ||
    session.metadata?.expected_amount !== String(paidAmount)
  ) {
    throw new Error(
      "Pagamento o prenotazione non corrispondenti"
    );
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
      "Pagamento ricevuto ma pixel non assegnabili"
    );
  }

  console.log("Pagamento confermato:", session.id);

  if (session.metadata?.content_type === "color") {
    await approveColorSpace(spaceId, session.id);
  }
}

async function handleExpired(session) {
  if (
    !session ||
    session.livemode !== true ||
    typeof session.id !== "string" ||
    !session.id.startsWith("cs_live_") ||
    session.status !== "expired" ||
    session.payment_status === "paid"
  ) {
    throw new Error("Sessione scaduta non valida");
  }

  const spaceId = getSpaceId(session);
  const space = await getSpace(spaceId);

  if (space.status === "sold") return;

  if (
    space.status !== "reserved" ||
    space.stripe_session_id !== session.id
  ) {
    return;
  }

  const released = await supabaseRequest(
    "rpc/release_expired_wall_checkout",
    {
      method: "POST",
      body: JSON.stringify({
        p_space_id: spaceId,
        p_stripe_session_id: session.id
      })
    }
  );

  if (released !== true) {
    throw new Error(
      "Impossibile liberare la prenotazione"
    );
  }

  console.log(
    "Prenotazione scaduta liberata:",
    session.id
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (
    !secret ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SECRET_KEY
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
      secret
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

  try {
    if (event.type === "checkout.session.completed") {
      await confirmPayment(event.data?.object);
    } else if (event.type === "checkout.session.expired") {
      await handleExpired(event.data?.object);
    }

    return res.status(200).json({
      received: true
    });

  } catch (error) {
    console.error(
      "Errore webhook:",
      error.message
    );

    return res.status(500).json({
      error: "Evento non elaborato"
    });
  }
}
