'use strict';

const bcrypt = require('bcryptjs');
const express = require('express');
const {
  generateFeedback,
  isAiEnabled,
  runManagerChat,
  suggestTaskAssignment,
  triageInitial
} = require('./ai');
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
  const result = await query(
    `
      SELECT
        t.*,
        u.name AS emp_name,
        u.color,
        u.pastel,
        u.col_bg,
        u.board_bg,
        creator.name AS created_by_name,
        updater.name AS updated_by_name
      FROM tasks t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN users creator ON creator.id = t.created_by_user_id
      LEFT JOIN users updater ON updater.id = t.updated_by_user_id
      WHERE u.role = 'employee' AND u.is_active = TRUE
      ORDER BY t.created_at DESC
    `
  );

  res.json(result.rows.map(normalizeTask));
}));

router.post('/tasks', requireAuth, asyncHandler(async (req, res) => {
  const task = await createTaskRecord({
    actorUser: req.user,
    data: req.body
  });
  res.status(201).json(task);
}));

router.put('/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const task = await updateTaskRecord({
    taskId: req.params.id,
    actorUser: req.user,
    data: req.body
  });
  res.json(task);
}));

router.patch('/tasks/:id/status', requireAuth, asyncHandler(async (req, res) => {
  const task = await changeTaskStatusRecord({
    taskId: req.params.id,
    actorUser: req.user,
    data: req.body
  });
  res.json(task);
}));

router.delete('/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  await deleteTaskRecord({
    taskId: req.params.id,
    actorUser: req.user
  });
  res.json({ ok: true });
}));

router.get('/team', requireAuth, asyncHandler(async (req, res) => {
  const params = [];
  let where = "WHERE role = 'employee' AND is_active = TRUE";

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
          SELECT
            t.*,
            creator.name AS created_by_name,
            updater.name AS updated_by_name
          FROM tasks t
          LEFT JOIN users creator ON creator.id = t.created_by_user_id
          LEFT JOIN users updater ON updater.id = t.updated_by_user_id
          WHERE t.user_id = $1 AND t.status IN ('todo', 'doing')
          ORDER BY t.created_at DESC
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

router.post('/manager/ai/chat', requireManager, asyncHandler(async (req, res) => {
  const inputJson = {
    message: cleanText(req.body.message),
    history: Array.isArray(req.body.history) ? req.body.history.slice(-8) : []
  };

  try {
    const outputJson = await runManagerChat(inputJson);
    const run = await persistAiRun({
      kind: 'chat',
      createdByUserId: req.user.id,
      inputJson,
      outputJson,
      status: 'completed'
    });
    res.json(Object.assign({ runId: run.id, enabled: isAiEnabled() }, outputJson));
  } catch (error) {
    await persistAiRun({
      kind: 'chat',
      createdByUserId: req.user.id,
      inputJson,
      outputJson: { error: error.message },
      status: 'failed'
    });
    throw error;
  }
}));

router.post('/manager/ai/execute', requireManager, asyncHandler(async (req, res) => {
  const inputJson = {
    type: cleanText(req.body.type),
    taskId: cleanText(req.body.taskId),
    payload: req.body && typeof req.body.payload === 'object' ? req.body.payload : {}
  };

  try {
    const outputJson = await executeAssistantTaskAction({
      actorUser: req.user,
      action: inputJson
    });
    const run = await persistAiRun({
      kind: 'chat',
      createdByUserId: req.user.id,
      inputJson,
      outputJson,
      status: 'completed'
    });
    res.json(Object.assign({ runId: run.id }, outputJson));
  } catch (error) {
    await persistAiRun({
      kind: 'chat',
      createdByUserId: req.user.id,
      inputJson,
      outputJson: { error: error.message },
      status: 'failed'
    });
    throw error;
  }
}));

router.post('/manager/ai/feedback', requireManager, asyncHandler(async (req, res) => {
  const inputJson = { period: req.body.period };

  try {
    const outputJson = await generateFeedback(inputJson);
    const run = await persistAiRun({
      kind: 'feedback',
      createdByUserId: req.user.id,
      inputJson,
      outputJson,
      status: 'completed'
    });
    res.json(Object.assign({ runId: run.id, enabled: isAiEnabled() }, outputJson));
  } catch (error) {
    await persistAiRun({
      kind: 'feedback',
      createdByUserId: req.user.id,
      inputJson,
      outputJson: { error: error.message },
      status: 'failed'
    });
    throw error;
  }
}));

router.post('/manager/ai/task-assignment', requireManager, asyncHandler(async (req, res) => {
  const inputJson = {
    title: cleanText(req.body.title),
    description: cleanText(req.body.description),
    assignedBy: cleanText(req.body.assignedBy)
  };

  try {
    const outputJson = await suggestTaskAssignment(inputJson);
    const run = await persistAiRun({
      kind: 'assignment',
      createdByUserId: req.user.id,
      inputJson,
      outputJson,
      status: 'completed'
    });
    res.json(Object.assign({ runId: run.id, enabled: isAiEnabled() }, outputJson));
  } catch (error) {
    await persistAiRun({
      kind: 'assignment',
      createdByUserId: req.user.id,
      inputJson,
      outputJson: { error: error.message },
      status: 'failed'
    });
    throw error;
  }
}));

router.post('/manager/ai/initial-triage', requireManager, asyncHandler(async (req, res) => {
  const inputJson = {
    title: cleanText(req.body.title),
    initialText: cleanText(req.body.initialText),
    contextNote: cleanText(req.body.contextNote)
  };

  try {
    const outputJson = await triageInitial(inputJson);
    const run = await persistAiRun({
      kind: 'initial_triage',
      createdByUserId: req.user.id,
      inputJson,
      outputJson,
      status: 'completed'
    });
    res.json(Object.assign({ runId: run.id, enabled: isAiEnabled() }, outputJson));
  } catch (error) {
    await persistAiRun({
      kind: 'initial_triage',
      createdByUserId: req.user.id,
      inputJson,
      outputJson: { error: error.message },
      status: 'failed'
    });
    throw error;
  }
}));

router.post('/manager/ai/initial-triage/:runId/create-tasks', requireManager, asyncHandler(async (req, res) => {
  const run = await findAiRun(req.params.runId, 'initial_triage');
  if (!run) {
    return res.status(404).json({ error: 'Analise de inicial nao encontrada' });
  }
  if (Number(run.created_by_user_id) !== req.user.id) {
    return res.status(403).json({ error: 'Esta analise pertence a outra sessao de gestor' });
  }

  const output = typeof run.output_json === 'string' ? JSON.parse(run.output_json) : run.output_json;
  const suggestedTasks = Array.isArray(output && output.suggestedTasks) ? output.suggestedTasks : [];
  if (!suggestedTasks.length) {
    return res.status(400).json({ error: 'Esta analise nao possui tarefas sugeridas' });
  }

  const created = await withTransaction(async (client) => {
    const inserted = [];
    for (const suggestion of suggestedTasks) {
      const owner = await client.query(
        `
          SELECT id, role, is_active
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [Number(suggestion.assignedToUserId)]
      );
      const user = owner.rows[0];
      if (!user || !user.is_active || user.role !== 'employee') {
        continue;
      }

      const taskId = uid();
      await client.query(
        `
          INSERT INTO tasks (
            id, title, description, notes, assigned_by, user_id, created_by_user_id, updated_by_user_id, status, timer_start
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'todo', NULL)
        `,
        [
          taskId,
          cleanText(suggestion.title) || 'Tarefa sugerida',
          cleanText(suggestion.description) || 'Gerada a partir da triagem da inicial',
          '',
          req.user.name,
          Number(suggestion.assignedToUserId),
          req.user.id,
          req.user.id
        ]
      );

      const selected = await client.query(taskSelectById(), [taskId]);
      const taskRow = selected.rows[0];
      inserted.push(normalizeTask(taskRow));
      await client.query(
        `
          INSERT INTO task_activity (task_id, action, actor_user_id, target_user_id, before_json, after_json)
          VALUES ($1, 'create', $2, $3, NULL, $4::jsonb)
        `,
        [taskId, req.user.id, Number(suggestion.assignedToUserId), JSON.stringify(taskSnapshot(taskRow))]
      );
    }
    return inserted;
  });

  res.status(201).json({ ok: true, created });
}));

async function executeAssistantTaskAction(input) {
  const action = sanitizeAssistantAction(input.action);
  const activityMeta = { origin: 'assistant', confirmedByUserId: Number(input.actorUser.id) };

  if (action.type === 'create_task') {
    const task = await createTaskRecord({
      actorUser: input.actorUser,
      data: action.payload,
      activityMeta
    });
    return {
      ok: true,
      type: action.type,
      message: 'Tarefa criada via assistente para ' + task.empName + '.',
      task
    };
  }

  if (action.type === 'update_task' || action.type === 'reassign_task') {
    const task = await updateTaskRecord({
      taskId: action.taskId,
      actorUser: input.actorUser,
      data: action.payload,
      activityMeta
    });
    return {
      ok: true,
      type: action.type,
      message: action.type === 'reassign_task'
        ? 'Tarefa redistribuida para ' + task.empName + '.'
        : 'Tarefa atualizada via assistente.',
      task
    };
  }

  if (action.type === 'change_status') {
    const task = await changeTaskStatusRecord({
      taskId: action.taskId,
      actorUser: input.actorUser,
      data: action.payload,
      activityMeta
    });
    return {
      ok: true,
      type: action.type,
      message: 'Status alterado para ' + statusLabel(task.status) + '.',
      task
    };
  }

  if (action.type === 'delete_task') {
    const deletedTask = await deleteTaskRecord({
      taskId: action.taskId,
      actorUser: input.actorUser,
      activityMeta
    });
    return {
      ok: true,
      type: action.type,
      message: 'Tarefa removida via assistente.',
      deletedTaskId: deletedTask.id,
      deletedTaskTitle: deletedTask.title
    };
  }

  throw httpError(400, 'Tipo de acao nao suportado');
}

async function createTaskRecord(input) {
  const actorUser = input.actorUser;
  const data = input.data || {};
  const title = cleanText(data.title);
  const description = cleanText(data.description);
  const notes = cleanText(data.notes);
  const assignedBy = cleanText(data.assignedBy);
  const requestedStatus = cleanStatus(data.status);
  const requestedUserId = Number(data.userId || actorUser.id);

  if (!title) {
    throw httpError(400, 'Titulo obrigatorio');
  }

  const owner = await findEmployeeTarget(requestedUserId || actorUser.id);
  const taskId = cleanText(data.id) || uid();
  const status = requestedStatus || 'todo';
  const timerStart = status === 'doing' ? Date.now() : null;

  await query(
    `
      INSERT INTO tasks (
        id, title, description, notes, assigned_by, user_id, created_by_user_id, updated_by_user_id, status, timer_start
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [taskId, title, description, notes, assignedBy, owner.id, actorUser.id, actorUser.id, status, timerStart]
  );

  const result = await query(taskSelectById(), [taskId]);
  await logTaskActivity({
    taskId,
    action: 'create',
    actorUserId: actorUser.id,
    targetUserId: owner.id,
    before: null,
    after: taskSnapshot(result.rows[0]),
    meta: input.activityMeta
  });
  return normalizeTask(result.rows[0]);
}

async function updateTaskRecord(input) {
  const actorUser = input.actorUser;
  const data = input.data || {};
  const task = await findTask(input.taskId);
  if (!task) {
    throw httpError(404, 'Tarefa nao encontrada');
  }

  const title = data.title == null ? task.title : cleanText(data.title);
  const requestedUserId = data.userId == null ? Number(task.user_id) : Number(data.userId);
  if (!title) {
    throw httpError(400, 'Titulo obrigatorio');
  }

  const owner = await findEmployeeTarget(requestedUserId);
  const action = Number(task.user_id) !== Number(requestedUserId) ? 'reassign' : 'update';
  const before = taskSnapshot(task);

  await query(
    `
      UPDATE tasks
      SET
        title = $1,
        description = $2,
        notes = $3,
        assigned_by = $4,
        user_id = $5,
        updated_by_user_id = $6,
        last_edited_at = NOW(),
        updated_at = NOW()
      WHERE id = $7
    `,
    [
      title,
      cleanNullableText(data.description, task.description),
      cleanNullableText(data.notes, task.notes),
      cleanNullableText(data.assignedBy, task.assigned_by),
      owner.id,
      actorUser.id,
      input.taskId
    ]
  );

  const result = await query(taskSelectById(), [input.taskId]);
  await logTaskActivity({
    taskId: input.taskId,
    action,
    actorUserId: actorUser.id,
    targetUserId: owner.id,
    before,
    after: taskSnapshot(result.rows[0]),
    meta: input.activityMeta
  });
  return normalizeTask(result.rows[0]);
}

async function changeTaskStatusRecord(input) {
  const actorUser = input.actorUser;
  const data = input.data || {};
  const task = await findTask(input.taskId);
  if (!task) {
    throw httpError(404, 'Tarefa nao encontrada');
  }

  const newStatus = cleanStatus(data.newStatus);
  if (!newStatus) {
    throw httpError(400, 'Status invalido');
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

  const flags = normalizeTaskFlags(data);

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
        updated_by_user_id = $11,
        last_edited_at = NOW(),
        updated_at = NOW()
      WHERE id = $12
    `,
    [
      newStatus,
      elapsed,
      timerStart,
      completedAt,
      flags.needsRevisao,
      flags.needsProtocolo,
      flags.flagAgendei,
      flags.flagDispensa,
      flags.flagProtreal,
      flags.flagNaoAplic,
      actorUser.id,
      input.taskId
    ]
  );

  const result = await query(taskSelectById(), [input.taskId]);
  await logTaskActivity({
    taskId: input.taskId,
    action: 'status_change',
    actorUserId: actorUser.id,
    targetUserId: Number(task.user_id),
    before: taskSnapshot(task),
    after: taskSnapshot(result.rows[0]),
    meta: input.activityMeta
  });
  return normalizeTask(result.rows[0]);
}

async function deleteTaskRecord(input) {
  const task = await findTask(input.taskId);
  if (!task) {
    throw httpError(404, 'Tarefa nao encontrada');
  }

  await logTaskActivity({
    taskId: input.taskId,
    action: 'delete',
    actorUserId: input.actorUser.id,
    targetUserId: Number(task.user_id),
    before: taskSnapshot(task),
    after: null,
    meta: input.activityMeta
  });
  await query('DELETE FROM tasks WHERE id = $1', [input.taskId]);
  return task;
}

function sanitizeAssistantAction(action) {
  const type = cleanText(action && action.type).toLowerCase();
  const taskId = cleanText(action && action.taskId);
  const payload = action && typeof action.payload === 'object' ? action.payload : {};
  const valid = ['create_task', 'update_task', 'change_status', 'reassign_task', 'delete_task'];

  if (!valid.includes(type)) {
    throw httpError(400, 'Acao do assistente invalida');
  }
  if (type !== 'create_task' && !taskId) {
    throw httpError(400, 'Tarefa alvo obrigatoria para essa acao');
  }

  return { type, taskId, payload };
}

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

function normalizeTaskFlags(value) {
  return {
    needsRevisao: !!value.needsRevisao,
    needsProtocolo: !!value.needsProtocolo,
    flagAgendei: !!value.flagAgendei,
    flagDispensa: !!value.flagDispensa,
    flagProtreal: !!value.flagProtreal,
    flagNaoAplic: !!value.flagNaoAplic
  };
}

function statusLabel(value) {
  return {
    todo: 'A Fazer',
    doing: 'Em andamento',
    done: 'Concluida'
  }[value] || value;
}

function isValidUsername(value) {
  return /^[a-z0-9._-]+$/.test(value);
}

async function findTask(id) {
  const result = await query('SELECT * FROM tasks WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function findEmployeeTarget(id) {
  const result = await query(
    `
      SELECT id, name, role, is_active
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );
  const user = result.rows[0];
  if (!user || !user.is_active) {
    throw httpError(404, 'Responsavel nao encontrado ou inativo');
  }
  if (user.role !== 'employee') {
    throw httpError(400, 'As tarefas devem ser atribuidas a funcionarios');
  }
  return user;
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

async function findAiRun(id, kind) {
  const params = [id];
  let where = 'WHERE id = $1';
  if (kind) {
    params.push(kind);
    where += ' AND kind = $2';
  }

  const result = await query(
    `
      SELECT id, kind, created_by_user_id, input_json, output_json, status, created_at
      FROM ai_runs
      ${where}
      LIMIT 1
    `,
    params
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
      u.board_bg,
      creator.name AS created_by_name,
      updater.name AS updated_by_name
    FROM tasks t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN users creator ON creator.id = t.created_by_user_id
    LEFT JOIN users updater ON updater.id = t.updated_by_user_id
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
    createdByUserId: task.created_by_user_id == null ? null : Number(task.created_by_user_id),
    createdByName: task.created_by_name || null,
    updatedByUserId: task.updated_by_user_id == null ? null : Number(task.updated_by_user_id),
    updatedByName: task.updated_by_name || null,
    lastEditedAt: task.last_edited_at || task.updated_at || null,
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
    createdByUserId: task.created_by_user_id == null ? null : Number(task.created_by_user_id),
    createdByName: task.created_by_name || null,
    updatedByUserId: task.updated_by_user_id == null ? null : Number(task.updated_by_user_id),
    updatedByName: task.updated_by_name || null,
    lastEditedAt: task.last_edited_at || task.updated_at || null,
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

async function logTaskActivity(input) {
  await query(
    `
      INSERT INTO task_activity (
        task_id,
        action,
        actor_user_id,
        target_user_id,
        before_json,
        after_json
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
    `,
    [
      input.taskId,
      input.action,
      input.actorUserId,
      input.targetUserId,
      input.before ? JSON.stringify(attachActivityMeta(input.before, input.meta)) : null,
      input.after ? JSON.stringify(attachActivityMeta(input.after, input.meta)) : null
    ]
  );
}

function attachActivityMeta(snapshot, meta) {
  if (!snapshot) return null;
  if (!meta) return snapshot;
  return Object.assign({}, snapshot, { _activity: meta });
}

async function persistAiRun(input) {
  const result = await query(
    `
      INSERT INTO ai_runs (kind, created_by_user_id, input_json, output_json, status)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
      RETURNING id, kind, created_by_user_id, status, created_at
    `,
    [
      input.kind,
      input.createdByUserId,
      JSON.stringify(input.inputJson || {}),
      input.outputJson == null ? null : JSON.stringify(input.outputJson),
      input.status || 'completed'
    ]
  );
  return result.rows[0];
}

function taskSnapshot(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    notes: task.notes,
    assignedBy: task.assigned_by,
    userId: Number(task.user_id),
    createdByUserId: task.created_by_user_id == null ? null : Number(task.created_by_user_id),
    updatedByUserId: task.updated_by_user_id == null ? null : Number(task.updated_by_user_id),
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
    lastEditedAt: task.last_edited_at || task.updated_at || null
  };
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
