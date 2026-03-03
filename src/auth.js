import jwt from "jsonwebtoken";

export function requireJWT(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireManager(req, res, next) {
  const r = req.user?.role;
  if (r !== "manager" && r !== "admin") {
    return res.status(403).json({ error: "Manager access required" });
  }
  next();
}
