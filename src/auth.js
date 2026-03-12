import jwt from "jsonwebtoken";

export function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET manquant dans .env");
  return jwt.sign(payload, secret, { expiresIn: "12h" });
}

export function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET manquant dans .env");
  return jwt.verify(token, secret);
}

export function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: "Non authentifié" });

  try {
    const decoded = verifyToken(m[1]);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide" });
  }
}