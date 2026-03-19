'use strict';

const bcrypt = require('bcryptjs');
const express = require('express');
const { normalizeUsername, pickTheme, query, withTransaction } = require('./db');
const { requireAuth, requireManager, signToken } = require('./auth');

const router = express.Router();

router.post('/auth/login', asyncHandler(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = req.body.password || '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario e senha obrigatorios' });
  }

  const result = await query(
    `
      SELECT id, username, name, password, role, is_active, color, pastel, col_bg, board_bg
      FROM users
      WHERE username = $1
      LIMIT 1
    `,
    [username]
  );

  const user = result.rows[0];
  if (!user || !user.is_active || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Usuario ou senha incorretos' });
  }

  const token = signToken({
    id: Number(user.id),
    username: user.username,
    name: user.name,
    role: user.role
  });

  res.cookie('token', token, cookieOptions());
  return res.json({
    token,
    user: normalizeUser(user)
  });
}));

router.post('/auth/logout', (req, res) => {
  res.clearCookie('token', clearCookieOptions());
  res.json({ ok: true });
});

router.get('/auth/me', requireAuth, asyncHandler(async (req, res) => {
  const result = await query(
    `
      SELECT id, username, name, role, is_active, color, pastel, col_bg, board_bg
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [req.user.id]
  );

  const user = result.rows[0];
  if (!user || !user.is_active) {
    return res.status(404).json({ error: 'Usuario nao encontrado' });
  }

  return res.json(normalizeUser(user));
}));

router.post('/auth/change-password', requireAuth, asyncHandler(async (req, res) => {
  const currentPassword = req.body.currentPassword || '';
  const newPassword = req.body.newPassword || '';

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Campos obrigatorios' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  }

  const result = await query('SELECT password FROM users WHERE id = $1 LIMIT 1', [req.user.id]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Senha atual incorreta' });
  }

  await query('UPDATE users SET password = $1 WHERE id = $2', [
    bcrypt.hashSync(newPassword, 12),
    req.user.id
  ]);

  res.json({ ok: true, message: 'Senha alterada com sucesso' });
}));

router.get('/tasks', requireAuth, asyncHandler(async (req, res) => {
  const params = [];
  let where = '';

  if (req.user.role !== 'manager') {
    where = 'WHERE t.user_id = $1';
    params.push(req.user.id);
  }

  const result = await query(
    `
      SELECT
        t.*,
        u.name AS emp_name,
        u.color,
        u.pastel,
        u.col_bg,
        u.board_bg
      FROM tasks t
      JOIN users u ON u.id = t.user_id
      ${where}
      ORDER BY t.created_at DESC
    `,
    params
  );

  res.json(result.rows.map(normalizeTask));
}));

router.post('/tasks', requireAuth, asyncHandler(async (req, res) => {
  const title = cleanText(req.body.title);
  const description = cleanText(req.body.description);
  const notes = cleanText(req.body.notes);
  const assignedBy = cleanText(req.body.assignedBy);
  const requestedStatus = cleanStatus(req.body.status);
  const requestedUserId = Number(req.body.userId || req.user.id);

  if (!title) {
    return res.status(400).json({ error: 'Titulo obrigatorio' });
  }

  const userId = req.user.role === 'manager' ? requestedUserId : req.user.id;
  const userResult = await query(
    `
      SELECT id, name, role, is_active
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  );
  const owner = userResult.rows[0];

  if (!owner || !owner.is_active) {
    return res.status(404).json({ error: 'Responsavel nao encontrado ou inativo' });
  }

  if (owner.role !== 'employee' && req.user.role === 'manager') {
    return res.status(400).json({ error: 'As tarefas devem ser atribuidas a funcionarios' });
  }

  const taskId = cleanText(req.body.id) || uid();
  const status = requestedStatus || 'todo';
  const timerStart = status === 'doing' ? Date.now() : null;

  await query(
    `
      INSERT INTO tasks (
        id, title, description, notes, assigned_by, user_id, status, timer_start
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [taskId, title, description, notes, assignedBy, userId, status, timerStart]
  );

  const result = await query(taskSelectById(), [taskId]);
  res.status(201).json(normalizeTask(result.rows[0]));
}));

router.put('/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const task = await findTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Tarefa nao encontrada' });
  }

  if (req.user.role !== 'manager' && Number(task.user_id) !== req.user.id) {
    return res.status(403).json({ error: 'Sem permissao' });
  }

  const title = cleanText(req.body.title) || task.title;
  if (!title) {
    return res.status(400).json({ error: 'Titulo obrigatorio' });
  }

  await query(
    `
      UPDATE tasks
      SET
        title = $1,
        description = $2,
        notes = $3,
        assigned_by = $4,
        updated_at = NOW()
      WHERE id = $5
    `,
    [
      title,
      cleanNullableText(req.body.description, task.description),
      cleanNullableText(req.body.notes, task.notes),
      cleanNullableText(req.body.assignedBy, task.assigned_by),
      req.params.id
    ]
  );

  const result = await query(taskSelectById(), [req.params.id]);
  res.json(normalizeTask(result.rows[0]));
}));

router.patch('/tasks/:id/status', requireAuth, asyncHandler(async (req, res) => {
  const task = await findTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Tarefa nao encontrada' });
  }

  if (req.user.role !== 'manager' && Number(task.user_id) !== req.user.id) {
    return res.status(403).json({ error: 'Sem permissao' });
  }

  const newStatus = cleanStatus(req.body.newStatus);
  if (!newStatus) {
    return res.status(400).json({ error: 'Status invalido' });
  }

  const now = Date.now();
  let elapsed = Number(task.elapsed || 0);
  let timerStart = task.timer_start == null ? null : Number(task.timer_start);
  let completedAt = task.completed_at;

  if (task.status === 'doing' && timerStart) {
    elapsed += now - timerStart;
    timerStart = null;
  }
  if (newStatus === 'doing') {
    timerStart = now;
    completedAt = null;
  }
  if (newStatus === 'done') {
    completedAt = localTimeLabel();
    timerStart = null;
  }
  if (newStatus === 'todo') {
    completedAt = null;
  }

  await query(
    `
      UPDATE tasks
      SET
        status = $1,
        elapsed = $2,
        timer_start = $3,
        completed_at = $4,
        needs_revisao = $5,
        needs_protocolo = $6,
        flag_agendei = $7,
        flag_dispensa = $8,
        flag_protreal = $9,
        flag_naoaplic = $10,
        updated_at = NOW()
      WHERE id = $11
    `,
    [
      newStatus,
      elapsed,
      timerStart,
      completedAt,
      !!req.body.needsRevisao,
      !!req.body.needsProtocolo,
      !!req.body.flagAgendei,
      !!req.body.flagDispensa,
      !!req.body.flagProtreal,
      !!req.body.flagNaoAplic,
      req.params.id
    ]
  );

  const result = await query(taskSelectById(), [req.params.id]);
  res.json(normalizeTask(result.rows[0]));
}));

router.delete('/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const task = await findTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Tarefa nao encontrada' });
  }

  if (req.user.role !== 'manager' && Number(task.user_id) !== req.user.id) {
    return res.status(403).json({ error: 'Sem permissao' });
  }

  await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

router.get('/team', requireAuth, asyncHandler(async (req, res) => {
  const params = [];
  let where = "WHERE role = 'employee' AND is_active = TRUE";

  if (req.user.role !== 'manager') {
    where += ' AND id = $1';
    params.push(req.user.id);
  }

  const result = await query(
    `
      SELECT id, username, name, role, color, pastel, col_bg, board_bg
      FROM users
      ${where}
      ORDER BY name
    `,
    params
  );

  const employees = await Promise.all(
    result.rows.map(async (emp) => {
      const taskResult = await query(
        `
          SELECT *
          FROM tasks
          WHERE user_id = $1 AND status IN ('todo', 'doing')
          ORDER BY created_at DESC
        `,
        [emp.id]
      );

      return {
        ...normalizeUser(emp),
        tasks: taskResult.rows.map(normalizeTaskFromTaskOnly)
      };
    })
  );

  res.json(employees);
}));

router.get('/history', requireManager, asyncHandler(async (req, res) => {
  const params = [];
  const filters = [];

  if (req.query.date) {
    params.push(String(req.query.date));
    filters.push(`date = $${params.length}`);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await query(
    `
      SELECT id, date, closed_at, data
      FROM history_snapshots
      ${where}
      ORDER BY date DESC
      LIMIT 90
    `,
    params
  );

  const empId = req.query.empId ? String(req.query.empId) : '';
  const payload = result.rows.map((row) => {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const employees = empId
      ? (data.employees || []).filter((item) => String(item.empId) === empId)
      : (data.employees || []);

    return {
      id: Number(row.id),
      date: row.date,
      closedAt: row.closed_at,
      employees
    };
  });

  res.json(payload);
}));

router.post('/history/close-day', requireManager, asyncHandler(async (req, res) => {
  const today = todayStr();
  const closedAt = localTimeLabel();

  const employeesResult = await query(
    `
      SELECT id, name
      FROM users
      WHERE role = 'employee'
      ORDER BY name
    `
  );

  const employees = await Promise.all(
    employeesResult.rows.map(async (emp) => {
      const taskResult = await query(
        `
          SELECT *
          FROM tasks
          WHERE user_id = $1
          ORDER BY created_at DESC
        `,
        [emp.id]
      );

      const tasks = taskResult.rows.map((task) => ({
        title: task.title,
        description: task.description,
        assignedBy: task.assigned_by,
        status: task.status,
        elapsed: Number(task.elapsed || 0) + (task.timer_start ? (Date.now() - Number(task.timer_start)) : 0),
        completedAt: task.completed_at,
        needsRevisao: !!task.needs_revisao,
        needsProtocolo: !!task.needs_protocolo,
        flagAgendei: !!task.flag_agendei,
        flagDispensa: !!task.flag_dispensa,
        flagProtreal: !!task.flag_protreal,
        flagNaoAplic: !!task.flag_naoaplic
      }));

      return {
        empId: Number(emp.id),
        empName: emp.name,
        tasks
      };
    })
  );

  const snapshot = { employees: employees.filter((item) => item.tasks.length > 0) };

  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO history_snapshots (date, closed_at, data)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (date)
        DO UPDATE SET closed_at = EXCLUDED.closed_at, data = EXCLUDED.data
      `,
      [today, closedAt, JSON.stringify(snapshot)]
    );

    await client.query("DELETE FROM tasks WHERE status = 'done'");
  });

  res.json({ ok: true, date: today, closedAt });
}));

router.get('/manager/users', requireManager, asyncHandler(async (req, res) => {
  const result = await query(
    `
      SELECT
        id,
        username,
        name,
        role,
        is_active,
        color,
        pastel,
        col_bg,
        board_bg,
        created_at
      FROM users
      ORDER BY
        CASE WHEN role = 'manager' THEN 0 ELSE 1 END,
        is_active DESC,
        name ASC
    `
  );

  res.json(result.rows.map(normalizeUser));
}));

router.post('/manager/users', requireManager, asyncHandler(async (req, res) => {
  const name = cleanText(req.body.name);
  const username = normalizeUsername(req.body.username);
  const password = req.body.password || '';
  const role = cleanRole(req.body.role) || 'employee';

  if (!name || !username || password.length < 6) {
    return res.status(400).json({ error: 'Nome, usuario e senha inicial sao obrigatorios' });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Usuario deve usar letras minusculas, numeros, ponto, traco ou underline' });
  }

  const existing = await query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'Ja existe um usuario com esse login' });
  }

  const countResult = await query('SELECT COUNT(*)::int AS count FROM users');
  const theme = pickTheme(countResult.rows[0].count);

  const insertResult = await query(
    `
      INSERT INTO users (username, name, password, role, is_active, color, pastel, col_bg, board_bg)
      VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8)
      RETURNING id, username, name, role, is_active, color, pastel, col_bg, board_bg, created_at
    `,
    [
      username,
      name,
      bcrypt.hashSync(password, 12),
      role,
      theme.color,
      theme.pastel,
      theme.colBg,
      theme.boardBg
    ]
  );

  res.status(201).json(normalizeUser(insertResult.rows[0]));
}));

router.put('/manager/users/:id', requireManager, asyncHandler(async (req, res) => {
  const target = await findUser(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Usuario nao encontrado' });
  }

  const name = cleanText(req.body.name);
  const username = normalizeUsername(req.body.username);
  const role = cleanRole(req.body.role);

  if (!name || !username || !role) {
    return res.status(400).json({ error: 'Nome, usuario e perfil sao obrigatorios' });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Usuario deve usar letras minusculas, numeros, ponto, traco ou underline' });
  }

  const duplicate = await query(
    'SELECT id FROM users WHERE username = $1 AND id <> $2 LIMIT 1',
    [username, req.params.id]
  );
  if (duplicate.rows.length) {
    return res.status(409).json({ error: 'Ja existe um usuario com esse login' });
  }

  await ensureManagerMutationAllowed({
    actorId: req.user.id,
    currentRole: target.role,
    currentActive: target.is_active,
    nextRole: role,
    nextActive: target.is_active,
    targetId: Number(target.id)
  });

  const result = await query(
    `
      UPDATE users
      SET name = $1, username = $2, role = $3
      WHERE id = $4
      RETURNING id, username, name, role, is_active, color, pastel, col_bg, board_bg, created_at
    `,
    [name, username, role, req.params.id]
  );

  res.json(normalizeUser(result.rows[0]));
}));

router.patch('/manager/users/:id/status', requireManager, asyncHandler(async (req, res) => {
  const target = await findUser(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Usuario nao encontrado' });
  }

  const isActive = !!req.body.isActive;
  await ensureManagerMutationAllowed({
    actorId: req.user.id,
    currentRole: target.role,
    currentActive: target.is_active,
    nextRole: target.role,
    nextActive: isActive,
    targetId: Number(target.id)
  });

  if (!isActive) {
    const openTasks = await query(
      `
        SELECT COUNT(*)::int AS count
        FROM tasks
        WHERE user_id = $1 AND status IN ('todo', 'doing')
      `,
      [req.params.id]
    );
    if (openTasks.rows[0].count > 0) {
      return res.status(400).json({ error: 'Finalize ou redistribua as tarefas abertas antes de desativar o usuario' });
    }
  }

  const result = await query(
    `
      UPDATE users
      SET is_active = $1
      WHERE id = $2
      RETURNING id, username, name, role, is_active, color, pastel, col_bg, board_bg, created_at
    `,
    [isActive, req.params.id]
  );

  res.json(normalizeUser(result.rows[0]));
}));

router.put('/manager/users/:id/password', requireManager, asyncHandler(async (req, res) => {
  const newPassword = req.body.newPassword || '';
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  }

  const target = await findUser(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Usuario nao encontrado' });
  }

  await query('UPDATE users SET password = $1 WHERE id = $2', [
    bcrypt.hashSync(newPassword, 12),
    req.params.id
  ]);

  res.json({ ok: true });
}));

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/'
  };
}

function clearCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  };
}

function cleanNullableText(value, fallback) {
  return value == null ? fallback : cleanText(value);
}

function cleanText(value) {
  return String(value || '').trim();
}

function cleanStatus(value) {
  return ['todo', 'doing', 'done'].includes(value) ? value : '';
}

function cleanRole(value) {
  return ['employee', 'manager'].includes(value) ? value : '';
}

function isValidUsername(value) {
  return /^[a-z0-9._-]+$/.test(value);
}

async function findTask(id) {
  const result = await query('SELECT * FROM tasks WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function findUser(id) {
  const result = await query(
    `
      SELECT id, username, name, role, is_active, color, pastel, col_bg, board_bg, created_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );
  return result.rows[0] || null;
}

async function ensureManagerMutationAllowed(input) {
  const {
    actorId,
    currentRole,
    currentActive,
    nextRole,
    nextActive,
    targetId
  } = input;

  if (!nextActive && actorId === targetId) {
    throw httpError(400, 'Voce nao pode desativar o proprio acesso');
  }

  const stillCountsAsActiveManager =
    currentRole === 'manager' &&
    currentActive === true &&
    nextRole === 'manager' &&
    nextActive === true;

  if (stillCountsAsActiveManager) {
    return;
  }

  if (currentRole === 'manager' && currentActive === true) {
    const result = await query(
      "SELECT COUNT(*)::int AS count FROM users WHERE role = 'manager' AND is_active = TRUE"
    );
    if (result.rows[0].count <= 1) {
      throw httpError(400, 'O sistema precisa manter pelo menos um gestor ativo');
    }
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function taskSelectById() {
  return `
    SELECT
      t.*,
      u.name AS emp_name,
      u.color,
      u.pastel,
      u.col_bg,
      u.board_bg
    FROM tasks t
    JOIN users u ON u.id = t.user_id
    WHERE t.id = $1
    LIMIT 1
  `;
}

function normalizeUser(user) {
  return {
    id: Number(user.id),
    username: user.username,
    name: user.name,
    role: user.role,
    isActive: user.is_active !== false,
    color: user.color,
    pastel: user.pastel,
    colBg: user.col_bg,
    boardBg: user.board_bg,
    createdAt: user.created_at
  };
}

function normalizeTask(task) {
  return {
    id: task.id,
    title: task.title,
    desc: task.description,
    notes: task.notes,
    assignedBy: task.assigned_by,
    empId: Number(task.user_id),
    empName: task.emp_name,
    status: task.status,
    elapsed: Number(task.elapsed || 0),
    timerStart: task.timer_start == null ? null : Number(task.timer_start),
    completedAt: task.completed_at,
    needsRevisao: !!task.needs_revisao,
    needsProtocolo: !!task.needs_protocolo,
    flagAgendei: !!task.flag_agendei,
    flagDispensa: !!task.flag_dispensa,
    flagProtreal: !!task.flag_protreal,
    flagNaoAplic: !!task.flag_naoaplic,
    color: task.color,
    pastel: task.pastel,
    colBg: task.col_bg,
    boardBg: task.board_bg,
    createdAt: task.created_at
  };
}

function normalizeTaskFromTaskOnly(task) {
  return {
    id: task.id,
    title: task.title,
    desc: task.description,
    notes: task.notes,
    assignedBy: task.assigned_by,
    empId: Number(task.user_id),
    status: task.status,
    elapsed: Number(task.elapsed || 0),
    timerStart: task.timer_start == null ? null : Number(task.timer_start),
    completedAt: task.completed_at,
    needsRevisao: !!task.needs_revisao,
    needsProtocolo: !!task.needs_protocolo,
    flagAgendei: !!task.flag_agendei,
    flagDispensa: !!task.flag_dispensa,
    flagProtreal: !!task.flag_protreal,
    flagNaoAplic: !!task.flag_naoaplic,
    createdAt: task.created_at
  };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bahia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function localTimeLabel() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Bahia',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date());
}

module.exports = router;
