
const Stripe = require("stripe");

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  try {
    const sessionId = req.query.session_id;

    if (
      typeof sessionId !== "string" ||
      !/^cs_live_[A-Za-z0-9]+$/.test(sessionId)
    ) {
      return res.status(400).json({
        error: "Sessione Stripe non valida"
      });
    }

    const session =
      await stripe.checkout.sessions.retrieve(
        sessionId
      );

    if (
      session.mode !== "payment" ||
      session.payment_status !== "paid"
    ) {
      return res.status(200).json({
        paid: false
      });
    }

    const contentType =
      session.metadata?.content_type === "image"
        ? "image"
        : "color";

    return res.status(200).json({
      paid: true,
      content_type: contentType
    });

  } catch (error) {
    console.error(
      "Errore verifica pagamento:",
      error.message
    );

    return res.status(500).json({
      error: "Impossibile verificare il pagamento"
    });
  }
};
