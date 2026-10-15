

const BUCKET = "wall-images";
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

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

function serverError(res, status, message) {
  return res.status(status).json({
    success: false,
    error: message
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return serverError(
      res,
      405,
      "Metodo non consentito"
    );
  }

  // BLOCCO DI SICUREZZA:
  // nessun caricamento finché il sistema
  // non viene completato e verificato.
  if (
    process.env.ENABLE_IMAGE_UPLOADS !== "true" ||
    process.env.ENABLE_WALL_PAYMENTS !== "true"
  ) {
    return serverError(
      res,
      503,
      "Caricamento immagini non ancora attivo"
    );
  }

  const supabaseUrl =
    process.env.SUPABASE_URL?.replace(/\/$/, "");

  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY;

  const stripeKey =
    process.env.STRIPE_SECRET_KEY;

  if (
    !supabaseUrl ||
    !supabaseKey ||
    !stripeKey
  ) {
    return serverError(
      res,
      503,
      "Configurazione server incompleta"
    );
  }

  const {
    sessionId,
    contentType,
    fileSize
  } = req.body || {};

  if (!validSessionId(sessionId)) {
    return serverError(
      res,
      400,
      "Sessione di pagamento non valida"
    );
  }

  if (
    typeof contentType !== "string" ||
    !Object.hasOwn(IMAGE_TYPES, contentType)
  ) {
    return serverError(
      res,
      400,
      "Formato non valido. Usa PNG, JPG o WebP."
    );
  }

  if (
    !Number.isInteger(fileSize) ||
    fileSize < 1 ||
    fileSize > MAX_IMAGE_SIZE
  ) {
    return serverError(
      res,
      400,
      "L'immagine deve essere inferiore a 5 MB"
    );
  }

  try {
    // 1. Verifica il pagamento con Stripe.
    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          Authorization: `Bearer ${stripeKey}`
        },
        cache: "no-store"
      }
    );

    if (!stripeResponse.ok) {
      return serverError(
        res,
        403,
        "Pagamento non verificabile"
      );
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
      return serverError(
        res,
        403,
        "Pagamento non confermato"
      );
    }

    // 2. Recupera lo spazio acquistato
    // dai metadati verificati di Stripe.
    const spaceId = session.metadata?.space_id;

    if (!validUUID(spaceId)) {
      return serverError(
        res,
        403,
        "Spazio pubblicitario non valido"
      );
    }

    // 3. Controlla che il database confermi
    // l'acquisto dello stesso spazio.
    const query = new URLSearchParams({
      id: `eq.${spaceId}`,
      select:
        "id,width,height,status,stripe_session_id,approval_status,image_path"
    });

    const spaceResponse = await fetch(
      `${supabaseUrl}/rest/v1/wall_spaces?${query}`,
      {
        headers: {
          apikey: supabaseKey,
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (!spaceResponse.ok) {
      throw new Error(
        `Database HTTP ${spaceResponse.status}`
      );
    }

    const spaces = await spaceResponse.json();

    if (
      !Array.isArray(spaces) ||
      spaces.length !== 1
    ) {
      return serverError(
        res,
        404,
        "Spazio pubblicitario non trovato"
      );
    }

    const space = spaces[0];

    if (
      space.status !== "sold" ||
      space.stripe_session_id !== sessionId ||
      space.approval_status !== "pending_review" ||
      space.image_path
    ) {
      return serverError(
        res,
        409,
        "Questo spazio non accetta nuovi caricamenti"
      );
    }

    // 4. Controlla che il prezzo pagato
    // corrisponda esattamente ai pixel.
    const expectedAmount =
      space.width * space.height * 100;

    if (
      !Number.isSafeInteger(expectedAmount) ||
      expectedAmount < 100 ||
      session.amount_total !== expectedAmount ||
      session.amount_subtotal !== expectedAmount ||
      session.metadata?.expected_amount !==
        String(expectedAmount)
    ) {
      return serverError(
        res,
        403,
        "Importo del pagamento non corrispondente"
      );
    }

    // 5. Prepara un percorso privato
    // appartenente soltanto allo spazio pagato.
    const extension = IMAGE_TYPES[contentType];

    const imagePath =
      `${spaceId}/advertisement.${extension}`;

    const encodedPath = imagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    // 6. Richiede a Supabase un token temporaneo
    // per caricare il file nel bucket privato.
    const uploadResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${encodedPath}`,
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
        `Storage HTTP ${uploadResponse.status}`
      );
    }

    const uploadData = await uploadResponse.json();

    if (
      typeof uploadData.token !== "string" ||
      !uploadData.token
    ) {
      throw new Error(
        "Autorizzazione caricamento mancante"
      );
    }

    // 7. Restituisce soltanto le informazioni
    // necessarie al caricamento.
    // Nessuna chiave segreta viene inviata.
    return res.status(200).json({
      success: true,
      bucket: BUCKET,
      path: imagePath,
      token: uploadData.token,
      contentType,
      maxBytes: MAX_IMAGE_SIZE,
      message: "Caricamento autorizzato"
    });

  } catch (error) {
    console.error(
      "Upload image error:",
      error.message
    );

    return serverError(
      res,
      503,
      "Impossibile autorizzare il caricamento"
    );
  }
}
