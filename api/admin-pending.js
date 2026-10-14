
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !publishableKey || !secretKey) {
    return res.status(503).json({
      error: "Configurazione server incompleta"
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
    // Verifica il token direttamente con Supabase Auth.
    const userResponse = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey: publishableKey,
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

    // Verifica che l'utente sia un amministratore.
    const adminResponse = await fetch(
      `${supabaseUrl}/rest/v1/wall_admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`,
      {
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`
        }
      }
    );

    if (!adminResponse.ok) {
      throw new Error("Verifica amministratore fallita");
    }

    const admins = await adminResponse.json();

    if (!Array.isArray(admins) || admins.length !== 1) {
      return res.status(403).json({
        error: "Non hai i permessi di amministratore"
      });
    }

    // Recupera soltanto gli spazi pagati
    // che attendono l'approvazione.
    const params = new URLSearchParams({
      select: "id,x,y,width,height,color,image_url,image_path,link_url,approval_status,created_at",
      status: "eq.sold",
      approval_status: "eq.pending_review",
      order: "created_at.asc",
      limit: "100"
    });

    const spacesResponse = await fetch(
      `${supabaseUrl}/rest/v1/wall_spaces?${params.toString()}`,
      {
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!spacesResponse.ok) {
      throw new Error("Caricamento pubblicità fallito");
    }

    const spaces = await spacesResponse.json();

    if (!Array.isArray(spaces)) {
      throw new Error("Risposta database non valida");
    }

    return res.status(200).json({
      spaces
    });

  } catch (error) {
    console.error("Admin pending error:", error);

    return res.status(500).json({
      error: "Impossibile caricare le pubblicità"
    });
  }
}
