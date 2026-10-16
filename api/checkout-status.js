

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const sessionId = req.query.session_id;

  if (
    typeof sessionId !== "string" ||
    !/^cs_live_[A-Za-z0-9]+$/.test(sessionId)
  ) {
    return res.status(400).json({
      error: "Sessione Stripe non valida"
    });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeKey) {
    return res.status(503).json({
      error: "Configurazione Stripe incompleta"
    });
  }

  try {
    const response = await fetch(
      "https://api.stripe.com/v1/checkout/sessions/" +
        encodeURIComponent(sessionId),
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + stripeKey
        },
        cache: "no-store"
      }
    );

    if (!response.ok) {
      console.error(
        "Stripe checkout status:",
        response.status
      );

      return res.status(502).json({
        error: "Impossibile verificare il pagamento"
      });
    }

    const session = await response.json();

    const paid =
      session.id === sessionId &&
      session.livemode === true &&
      session.mode === "payment" &&
      session.status === "complete" &&
      session.payment_status === "paid" &&
      session.currency?.toLowerCase() === "eur";

    if (!paid) {
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
      error: "Verifica pagamento non disponibile"
    });
  }
}
