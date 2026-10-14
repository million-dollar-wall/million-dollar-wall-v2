
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const supabaseUrl =
    process.env.SUPABASE_URL?.replace(/\/$/, "");

  const publicKey =
    process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !publicKey) {
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

  if (!token) {
    return res.status(401).json({
      error: "Token mancante"
    });
  }

  try {
    // 1. Verifica che il token sia valido.
    const userResponse = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey: publicKey,
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!userResponse.ok) {
      return res.status(401).json({
        error: "Sessione non valida o scaduta"
      });
    }

    const user = await userResponse.json();

    if (!user.id) {
      return res.status(401).json({
        error: "Utente non valido"
      });
    }

    // 2. Controlla che sia un amministratore.
    // La policy RLS permette di leggere
    // soltanto la propria riga.
    const adminParams = new URLSearchParams({
      user_id: `eq.${user.id}`,
      select: "user_id"
    });

    const adminResponse = await fetch(
      `${supabaseUrl}/rest/v1/wall_admins?${adminParams}`,
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
        error: "Impossibile verificare l'amministratore"
      });
    }

    const admins = await adminResponse.json();

    if (!Array.isArray(admins) || admins.length !== 1) {
      return res.status(403).json({
        error: "Account non autorizzato"
      });
    }

    // 3. Recupera le pubblicità in attesa.
    // Non usiamo la chiave segreta.
    const spacesParams = new URLSearchParams({
      select: "id,x,y,width,height,color,image_url,image_path,link_url,approval_status,created_at",
      status: "eq.sold",
      approval_status: "eq.pending_review",
      order: "created_at.asc",
      limit: "100"
    });

    const spacesResponse = await fetch(
      `${supabaseUrl}/rest/v1/wall_spaces?${spacesParams}`,
      {
        headers: {
          apikey: publicKey,
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      }
    );

    if (!spacesResponse.ok) {
      console.error(
        "Pending spaces fetch failed:",
        spacesResponse.status
      );

      return res.status(503).json({
        error: "Impossibile caricare le pubblicità"
      });
    }

    const spaces = await spacesResponse.json();

    if (!Array.isArray(spaces)) {
      return res.status(500).json({
        error: "Risposta database non valida"
      });
    }

    return res.status(200).json({
      spaces
    });

  } catch (error) {
    console.error(
      "Admin pending error:",
      error.message
    );

    return res.status(500).json({
      error: "Errore durante il caricamento"
    });
  }
}
