'use strict';

const jwt = require('jsonwebtoken');
const { query } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production';
const TOKEN_TTL = '8h';

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.cookies && req.cookies.token) return req.cookies.token;
  return null;
}

async function loadActiveUser(token) {
  const payload = verifyToken(token);
  const result = await query(
    `
      SELECT id, username, name, role, is_active, color, pastel, col_bg, board_bg
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [payload.id]
  );

  const user = result.rows[0];
  if (!user || !user.is_active) {
    throw new Error('inactive-user');
  }

  return {
    id: Number(user.id),
    username: user.username,
    name: user.name,
    role: user.role,
    isActive: user.is_active,
    color: user.color,
    pastel: user.pastel,
    colBg: user.col_bg,
    boardBg: user.board_bg
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Nao autenticado' });
    }

    req.user = await loadActiveUser(token);
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Sessao expirada, invalida ou usuario inativo' });
  }
}

async function requireManager(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Nao autenticado' });
    }

    const user = await loadActiveUser(token);
    if (user.role !== 'manager') {
      return res.status(403).json({ error: 'Acesso restrito ao gestor' });
    }

    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Sessao expirada, invalida ou usuario inativo' });
  }
}

module.exports = {
  extractToken,
  requireAuth,
  requireManager,
  signToken,
  verifyToken
};
