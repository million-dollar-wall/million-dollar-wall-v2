
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !publishableKey || !secretKey) {
    return res.status(503).json({
      error: "Configurazione Supabase incompleta"
    });
  }

  const { email, password } = req.body || {};

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !password
  ) {
    return res.status(400).json({
      error: "Inserisci email e password"
    });
  }

  try {
    // 1. Verifica email e password con Supabase.
    const authResponse = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: publishableKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password })
      }
    );

    const auth = await authResponse.json();

    if (!authResponse.ok || !auth.access_token || !auth.user?.id) {
      return res.status(401).json({
        error: "Email o password non valide"
      });
    }

    // 2. Controlla che l'utente sia nella tabella amministratori.
    const params = new URLSearchParams({
      user_id: `eq.${auth.user.id}`,
      select: "user_id"
    });

    const adminResponse = await fetch(
      `${supabaseUrl}/rest/v1/wall_admins?${params}`,
      {
        method: "GET",
        headers: {
          apikey: secretKey,
          Accept: "application/json"
        }
      }
    );

    if (!adminResponse.ok) {
      console.error(
        "Admin permission check failed:",
        adminResponse.status
      );

      return res.status(503).json({
        error: "Impossibile verificare i permessi"
      });
    }

    const admins = await adminResponse.json();

    if (!Array.isArray(admins) || admins.length !== 1) {
      return res.status(403).json({
        error: "Account non autorizzato come amministratore"
      });
    }

    // 3. Restituisce il token soltanto all'amministratore.
    return res.status(200).json({
      access_token: auth.access_token
    });

  } catch (error) {
    console.error("Admin login error:", error.message);

    return res.status(500).json({
      error: "Errore durante l'accesso"
    });
  }
}
