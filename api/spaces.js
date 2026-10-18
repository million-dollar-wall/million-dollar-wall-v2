

const BUCKET = "wall-images";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !publicKey || !secretKey) {
    return res.status(503).json({
      error: "Configurazione Supabase incompleta"
    });
  }

  try {
    // Recupera soltanto gli annunci venduti
    // e approvati dall'amministratore.
    const params = new URLSearchParams({
      status: "eq.sold",
      approval_status: "eq.approved",
      select:
        "id,x,y,width,height,color,link_url,image_path",
      order: "created_at.asc",
      limit: "1000"
    });

    const response = await fetch(
      `${url}/rest/v1/wall_spaces?${params}`,
      {
        headers: {
          apikey: publicKey,
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (!response.ok) {
      console.error(
        "Public spaces fetch failed:",
        response.status
      );

      return res.status(502).json({
        error: "Errore nel caricamento degli spazi"
      });
    }

    const spaces = await response.json();

    if (!Array.isArray(spaces)) {
      return res.status(502).json({
        error: "Risposta database non valida"
      });
    }

    // Genera un link temporaneo per ciascuna
    // immagine approvata nel bucket privato.
    const results = await Promise.all(
      spaces.map(async (space) => {
        const result = {
          id: space.id,
          x: space.x,
          y: space.y,
          width: space.width,
          height: space.height,
          color: space.color,
          link_url: space.link_url,
          image_url: null
        };

        if (!space.image_path) {
          return result;
        }

        // Accetta solo i percorsi delle immagini
        // appartenenti allo spazio pubblicitario.
        const allowedPath = new RegExp(
          `^${space.id}/advertisement\\.(png|jpg|webp)$`
        );

        if (!allowedPath.test(space.image_path)) {
          console.error(
            "Invalid image path for space:",
            space.id
          );
          return result;
        }

        try {
          const encodedPath = space.image_path
            .split("/")
            .map(encodeURIComponent)
            .join("/");

          const signResponse = await fetch(
            `${url}/storage/v1/object/sign/${BUCKET}/${encodedPath}`,
            {
              method: "POST",
              headers: {
                apikey: secretKey,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                expiresIn: 3600
              })
            }
          );

          if (!signResponse.ok) {
            console.error(
              "Image signing failed:",
              space.id,
              signResponse.status
            );
            return result;
          }

          const signed = await signResponse.json();

          if (
            typeof signed.signedURL !== "string" ||
            !signed.signedURL.startsWith("/")
          ) {
            console.error(
              "Invalid signed URL for space:",
              space.id
            );
            return result;
          }

          // CORREZIONE:
          // Supabase può restituire /object/sign/...
          // ma il percorso completo richiede
          // /storage/v1/object/sign/...

          let signedPath = signed.signedURL;

          if (signedPath.startsWith("/object/")) {
            signedPath = "/storage/v1" + signedPath;
          }

          // Evita di duplicare /storage/v1
          // quando è già presente.

          if (!signedPath.startsWith("/storage/v1/object/")) {
            console.error(
              "Unexpected signed URL path:",
              space.id
            );
            return result;
          }

          // URL temporaneo valido per un'ora.
          result.image_url = new URL(
            signedPath,
            url
          ).href;

        } catch (error) {
          console.error(
            "Image URL error:",
            space.id,
            error.message
          );
        }

        return result;
      })
    );

    return res.status(200).json({
      spaces: results
    });

  } catch (error) {
    console.error(
      "Spaces API error:",
      error.message
    );

    return res.status(500).json({
      error: "Impossibile contattare Supabase"
    });
  }
}
