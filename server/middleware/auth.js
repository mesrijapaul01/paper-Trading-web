const jwt = require("jsonwebtoken");

// Factory so both server.js and routes/*.js can share one implementation
// without a circular require on server.js.
function createVerifyToken(secret) {
  return function verifyToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(403).json({ message: "No token provided" });
    }
    const token = authHeader.split(" ")[1];
    jwt.verify(token, secret, (err, decoded) => {
      if (err) return res.status(401).json({ message: "Unauthorized" });
      req.userId = decoded.id;
      next();
    });
  };
}

module.exports = createVerifyToken;
