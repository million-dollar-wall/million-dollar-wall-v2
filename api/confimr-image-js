

const BUCKET = "wall-images";
const MAX_BYTES = 5 * 1024 * 1024;

const TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION = /^cs_live_[A-Za-z0-9]+$/;

function fail(res, status, message) {
  return res.status(status).json({
    success: false,
    error: message
  });
}

async function readJSON(response) {
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      "Servizio esterno HTTP " + response.status
    );
  }

  return data;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "Metodo non consentito");
  }

  // I caricamenti rimangono disattivati
  // fino all'abilitazione esplicita.
  if (
    process.env.ENABLE_WALL_PAYMENTS !== "true" ||
    process.env.ENABLE_IMAGE_UPLOADS !== "true"
  ) {
    return fail(
      res,
      503,
      "Caricamento immagini non ancora attivo"
    );
  }

  const url =
    process.env.SUPABASE_URL?.replace(/\/$/, "");

  const key = process.env.SUPABASE_SECRET_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!url || !key || !stripeKey) {
    return fail(
      res,
      503,
      "Configurazione server incompleta"
    );
  }

  const { sessionId, imagePath } = req.body || {};

  if (
    typeof sessionId !== "string" ||
    !SESSION.test(sessionId) ||
    typeof imagePath !== "string" ||
    imagePath.length > 150
  ) {
    return fail(res, 400, "Richiesta non valida");
  }

  try {
    // 1. Verifica il pagamento con Stripe.
    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions/" +
        encodeURIComponent(sessionId),
      {
        headers: {
          Authorization: "Bearer " + stripeKey
        },
        cache: "no-store"
      }
    );

    if (!stripeResponse.ok) {
      return fail(
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
      return fail(
        res,
        403,
        "Pagamento non confermato"
      );
    }

    // 2. Verifica che l'immagine appartenga
    // allo spazio effettivamente acquistato.
    const spaceId = session.metadata?.space_id;

    if (
      typeof spaceId !== "string" ||
      !UUID.test(spaceId)
    ) {
      return fail(
        res,
        403,
        "Spazio acquistato non valido"
      );
    }

    const allowedPath = new RegExp(
      "^" + spaceId +
        "/advertisement\\.(png|jpg|webp)$",
      "i"
    );

    if (!allowedPath.test(imagePath)) {
      return fail(
        res,
        403,
        "Immagine non associata all'acquisto"
      );
    }

    // 3. Controlla lo stato nel database.
    const params = new URLSearchParams({
      id: "eq." + spaceId,
      select:
        "id,width,height,status," +
        "stripe_session_id,approval_status,image_path"
    });

    const rows = await readJSON(
      await fetch(
        url + "/rest/v1/wall_spaces?" + params,
        {
          headers: {
            apikey: key,
            Accept: "application/json"
          },
          cache: "no-store"
        }
      )
    );

    if (
      !Array.isArray(rows) ||
      rows.length !== 1
    ) {
      return fail(res, 404, "Spazio non trovato");
    }

    const space = rows[0];

    if (
      space.status !== "sold" ||
      space.stripe_session_id !== sessionId ||
      space.approval_status !== "pending_review"
    ) {
      return fail(
        res,
        409,
        "Spazio non disponibile per la revisione"
      );
    }

    if (space.image_path === imagePath) {
      return res.status(200).json({
        success: true,
        status: "pending_review"
      });
    }

    if (space.image_path) {
      return fail(
        res,
        409,
        "Immagine già associata a questo spazio"
      );
    }

    // 4. Controlla il prezzo realmente pagato.
    const pixels = space.width * space.height;
    const expected = pixels * 100;

    if (
      !Number.isSafeInteger(expected) ||
      expected < 100 ||
      session.amount_total !== expected ||
      session.amount_subtotal !== expected ||
      session.metadata?.expected_amount !==
        String(expected) ||
      session.metadata?.pixels !== String(pixels)
    ) {
      return fail(
        res,
        403,
        "Importo del pagamento non corrispondente"
      );
    }

    // 5. Verifica che il file esista davvero
    // nello Storage privato di Supabase.
    const encodedPath = imagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const infoResponse = await fetch(
      url +
        "/storage/v1/object/info/" +
        BUCKET +
        "/" +
        encodedPath,
      {
        headers: {
          apikey: key
        },
        cache: "no-store"
      }
    );

    if (!infoResponse.ok) {
      return fail(
        res,
        409,
        "File non presente nello Storage"
      );
    }

    const info = await infoResponse.json();

    const size = Number(
      info.metadata?.size ??
      info.metadata?.contentLength ??
      info.size
    );

    const mime =
      info.metadata?.mimetype ??
      info.metadata?.contentType ??
      info.content_type;

    if (
      !Number.isFinite(size) ||
      size < 1 ||
      size > MAX_BYTES ||
      !TYPES.has(mime)
    ) {
      return fail(
        res,
        400,
        "Dimensione o formato del file non valido"
      );
    }

    // 6. Registra il logo soltanto se
    // nessun altro logo è già associato.
    const updateParams = new URLSearchParams({
      id: "eq." + spaceId,
      status: "eq.sold",
      stripe_session_id: "eq." + sessionId,
      approval_status: "eq.pending_review",
      image_path: "is.null",
      select: "id"
    });

    const updated = await readJSON(
      await fetch(
        url + "/rest/v1/wall_spaces?" + updateParams,
        {
          method: "PATCH",
          headers: {
            apikey: key,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            image_path: imagePath
          })
        }
      )
    );

    if (
      !Array.isArray(updated) ||
      updated.length !== 1
    ) {
      return fail(
        res,
        409,
        "Immagine già registrata o spazio modificato"
      );
    }

    // 7. Il logo resta in attesa
    // dell'approvazione dell'amministratore.
    return res.status(200).json({
      success: true,
      status: "pending_review"
    });

  } catch (error) {
    console.error(
      "Confirm image error:",
      error.message
    );

    return fail(
      res,
      503,
      "Impossibile confermare il caricamento"
    );
  }
}
