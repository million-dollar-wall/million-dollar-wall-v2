
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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

  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Accesso non autorizzato"
    });
  }

  const token = authorization.slice(7).trim();
  const { spaceId, action, reason } = req.body || {};

  if (
    typeof spaceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spaceId)
  ) {
    return res.status(400).json({
      error: "ID pubblicità non valido"
    });
  }

  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({
      error: "Azione non valida"
    });
  }

  if (
    action === "reject" &&
    (typeof reason !== "string" || !reason.trim())
  ) {
    return res.status(400).json({
      error: "Inserisci il motivo del rifiuto"
    });
  }

  try {
    // 1. Verifica l'identità dell'utente.
    const userResponse = await fetch(
      `${url}/auth/v1/user`,
      {
        headers: {
          apikey: publicKey,
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!userResponse.ok) {
      return res.status(401).json({
        error: "Sessione scaduta o non valida"
      });
    }

    const user = await userResponse.json();

    if (!user.id) {
      return res.status(401).json({
        error: "Utente non valido"
      });
    }

    // 2. Verifica che l'utente sia amministratore.
    const adminParams = new URLSearchParams({
      user_id: `eq.${user.id}`,
      select: "user_id"
    });

    const adminResponse = await fetch(
      `${url}/rest/v1/wall_admins?${adminParams}`,
      {
        headers: {
          apikey: publicKey,
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      }
    );

    if (!adminResponse.ok) {
      console.error(
        "Admin verification failed:",
        adminResponse.status
      );

      return res.status(503).json({
        error: "Impossibile verificare i permessi"
      });
    }

    const admins = await adminResponse.json();

    if (!Array.isArray(admins) || admins.length !== 1) {
      return res.status(403).json({
        error: "Account non autorizzato"
      });
    }

    // 3. Aggiorna esclusivamente una pubblicità
    // venduta e ancora in attesa di revisione.
    const params = new URLSearchParams({
      id: `eq.${spaceId}`,
      status: "eq.sold",
      approval_status: "eq.pending_review",
      select: "id,approval_status"
    });

    const update = {
      approval_status:
        action === "approve" ? "approved" : "rejected",
      reviewed_at: new Date().toISOString(),
      rejection_reason:
        action === "reject" ? reason.trim().slice(0, 500) : null
    };

    const updateResponse = await fetch(
      `${url}/rest/v1/wall_spaces?${params}`,
      {
        method: "PATCH",
        headers: {
          apikey: secretKey,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(update)
      }
    );

    if (!updateResponse.ok) {
      console.error(
        "Review update failed:",
        updateResponse.status,
        (await updateResponse.text()).slice(0, 500)
      );

      return res.status(503).json({
        error: "Impossibile aggiornare la pubblicità"
      });
    }

    const updated = await updateResponse.json();

    if (!Array.isArray(updated) || updated.length !== 1) {
      return res.status(409).json({
        error: "Pubblicità non trovata o già esaminata"
      });
    }

    return res.status(200).json({
      success: true,
      status: update.approval_status
    });

  } catch (error) {
    console.error("Admin review error:", error.message);

    return res.status(500).json({
      error: "Errore durante la revisione"
    });
  }
}
