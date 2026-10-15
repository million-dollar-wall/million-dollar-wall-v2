
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  // Caricamenti disattivati fino al completamento
  // dei controlli di prenotazione e pagamento.
  if (process.env.ENABLE_IMAGE_UPLOADS !== "true") {
    return res.status(503).json({
      error: "Caricamento immagini non ancora attivo"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !secretKey) {
    return res.status(503).json({
      error: "Configurazione server incompleta"
    });
  }

  // Ulteriore blocco di sicurezza:
  // nessun caricamento pubblico finché non esiste
  // un sistema verificato di autorizzazione
  // associato a una prenotazione valida.
  return res.status(503).json({
    error: "Autorizzazione al caricamento non ancora disponibile"
  });
}
