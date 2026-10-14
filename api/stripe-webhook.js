
import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;

  const parts = header.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));

  if (!timestamp || !signatures.length) return false;

  const time = Number(timestamp);
  if (!Number.isFinite(time)) return false;

  // Accetta soltanto eventi firmati negli ultimi 5 minuti.
  if (Math.abs(Date.now() / 1000 - time) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;

    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    return res.status(503).json({ error: "Webhook non configurato" });
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const payload = Buffer.concat(chunks).toString("utf8");

    if (
      !verifyStripeSignature(
        payload,
        req.headers["stripe-signature"],
        secret
      )
    ) {
      return res.status(400).json({ error: "Firma Stripe non valida" });
    }

    const event = JSON.parse(payload);

    if (event.type === "checkout.session.completed") {
      const session = event.data?.object;

      if (session?.payment_status === "paid") {
        // La conferma dei pixel sarà implementata qui,
        // dopo aver collegato prenotazioni e Checkout.
        console.log("Pagamento verificato:", session.id);
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Errore webhook:", error.message);
    return res.status(400).json({ error: "Evento non elaborabile" });
  }
}
