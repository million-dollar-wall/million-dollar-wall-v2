
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const enabled =
    process.env.ENABLE_IMAGE_UPLOADS === "true" &&
    process.env.ENABLE_WALL_PAYMENTS === "true";

  return res.status(200).json({
    enabled
  });
}
