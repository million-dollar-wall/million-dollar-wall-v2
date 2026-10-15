

const BUCKET = "wall-images";

function validSessionId(value) {
  return (
    typeof value === "string" &&
    /^cs_live_[A-Za-z0-9]+$/.test(value)
  );
}

function validUUID(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function validImageType(value) {
  return [
    "image/png",
    "image/jpeg",
    "image/webp"
  ].includes(value);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  // Il caricamento rimane spento finché
  // non avremo completato tutti i componenti.
  if (process.env.ENABLE_IMAGE_UPLOADS !== "true") {
    return res.status(503).json({
      error: "Caricamento immagini non ancora attivo"
    });
  }

  // Non consentire caricamenti mentre gli
  // acquisti del sito sono ancora disattivati.
  if (process.env.ENABLE_WALL_PAYMENTS !== "true") {
    return res.status(503).json({
      error: "Acquisti non ancora attivi"
    });
  }

  const supabaseUrl =
    process.env.SUPABASE_URL?.replace(/\/$/, "");

  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY;

  const stripeKey =
    process.env.STRIPE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey || !stripeKey) {
    return res.status(503).json({
      error: "Configurazione server incompleta"
    });
  }

  const { sessionId, contentType } = req.body || {};

  if (
    !validSessionId(sessionId) ||
    !validImageType(contentType)
  ) {
    return res.status(400).json({
      error: "Dati del caricamento non validi"
    });
  }

  try {
    // Verifica la sessione direttamente su Stripe.
    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          Authorization: `Bearer ${stripeKey}`
        }
      }
    );

    if (!stripeResponse.ok) {
      return res.status(403).json({
        error: "Impossibile verificare il pagamento"
      });
    }

    const session = await stripeResponse.json();

    if (
      session.id !== sessionId ||
      session.livemode !== true ||
      session.mode !== "payment" ||
      session.status !== "complete" ||
      session.payment_status !== "paid" ||
      session.currency?.toLowerCase() !== "eur"
    ) {
      return res.status(403).json({
        error: "Pagamento non confermato"
      });
    }

    const spaceId = session.metadata?.space_id;

    if (!validUUID(spaceId)) {
      return res.status(403).json({
        error: "Spazio pubblicitario non valido"
      });
    }

    // Verifica che il database abbia già
    // assegnato i pixel a questo pagamento.
    const query = new URLSearchParams({
      id: `eq.${spaceId}`,
      select:
        "id,width,height,status,stripe_session_id,approval_status,image_path"
    });

    const spaceResponse = await fetch(
      `${supabaseUrl}/rest/v1/wall_spaces?${query}`,
      {
        headers: {
          apikey: supabaseKey
        }
      }
    );

    if (!spaceResponse.ok) {
      throw new Error("Lettura spazio non riuscita");
    }

    const spaces = await spaceResponse.json();
    const space = spaces?.[0];

    if (
      spaces.length !== 1 ||
      space.status !== "sold" ||
      space.stripe_session_id !== sessionId ||
      space.approval_status !== "pending_review" ||
      space.image_path
    ) {
      return res.status(409).json({
        error: "Spazio non disponibile per il caricamento"
      });
    }

    const expectedAmount =
      space.width * space.height * 100;

    if (
      !Number.isSafeInteger(expectedAmount) ||
      session.amount_total !== expectedAmount ||
      session.amount_subtotal !== expectedAmount ||
      session.metadata?.expected_amount !==
        String(expectedAmount)
    ) {
      return res.status(403).json({
        error: "Importo del pagamento non corrispondente"
      });
    }

    const extension = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp"
    }[contentType];

    const imagePath = `${spaceId}/advertisement.${extension}`;

    // Richiede a Supabase un'autorizzazione
    // temporanea per caricare nel bucket privato.
    const uploadResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${imagePath}`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          upsert: false
        })
      }
    );

    if (!uploadResponse.ok) {
      throw new Error(
        `Autorizzazione Storage fallita: ${uploadResponse.status}`
      );
    }

    const uploadData = await uploadResponse.json();

    if (!uploadData.token) {
      throw new Error("Token caricamento mancante");
    }

    // Non restituisce mai la chiave segreta.
    return res.status(200).json({
      success: true,
      bucket: BUCKET,
      path: imagePath,
      token: uploadData.token,
      contentType,
      maxBytes: 5 * 1024 * 1024
    });

  } catch (error) {
    console.error(
      "Upload authorization error:",
      error.message
    );

    return res.status(503).json({
      error: "Impossibile autorizzare il caricamento"
    });
  }
}
