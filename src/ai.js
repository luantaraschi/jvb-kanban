'use strict';

const { query } = require('./db');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45000);

function isAiEnabled() {
  return process.env.AI_ENABLED !== 'false' && !!process.env.GEMINI_API_KEY;
}

function ensureAiEnabled() {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY nao configurada');
    error.status = 503;
    throw error;
  }
  if (process.env.AI_ENABLED === 'false') {
    const error = new Error('IA desativada no ambiente');
    error.status = 503;
    throw error;
  }
}

async function generateFeedback(input) {
  ensureAiEnabled();
  const period = cleanPeriod(input && input.period);
  const context = await buildManagerContext({ period });
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      teamHighlights: { type: 'array', items: { type: 'string' } },
      bottlenecks: { type: 'array', items: { type: 'string' } },
      recommendations: { type: 'array', items: { type: 'string' } },
      employees: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            empId: { type: 'integer' },
            name: { type: 'string' },
            scoreLabel: { type: 'string' },
            feedback: { type: 'string' },
            risk: { type: 'string' },
            nextStep: { type: 'string' }
          },
          required: ['empId', 'name', 'scoreLabel', 'feedback', 'risk', 'nextStep']
        }
      }
    },
    required: ['summary', 'teamHighlights', 'bottlenecks', 'recommendations', 'employees']
  };

  const result = await requestStructuredJson({
    schema,
    systemPrompt:
      'Voce e um analista operacional para escritorio de advocacia. ' +
      'Avalie produtividade com tom objetivo, pratico e profissional. ' +
      'Nao invente dados. Use somente o contexto fornecido.',
    userPayload: {
      goal: 'Gerar feedback de performance da equipe e por colaborador.',
      period,
      context
    }
  });

  return {
    period,
    contextMeta: context.meta,
    summary: result.summary,
    teamHighlights: ensureStringArray(result.teamHighlights),
    bottlenecks: ensureStringArray(result.bottlenecks),
    recommendations: ensureStringArray(result.recommendations),
    employees: sanitizeEmployeeFeedback(result.employees, context.employeeMetrics)
  };
}

async function suggestTaskAssignment(input) {
  ensureAiEnabled();
  const title = cleanText(input && input.title);
  const description = cleanText(input && input.description);
  const assignedBy = cleanText(input && input.assignedBy);
  const taskBatch = Array.isArray(input && input.tasks) ? input.tasks : [];
  if (!title) {
    if (!taskBatch.length) {
      const error = new Error('Titulo da tarefa obrigatorio');
      error.status = 400;
      throw error;
    }
  }

  const context = await buildManagerContext({ period: '30d' });
  const baseInput = {
    title,
    description,
    employees: context.employeeMetrics
  };
  const candidates = (await buildAssignmentCandidates(baseInput)).slice(0, 5);

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            userId: { type: 'integer' },
            name: { type: 'string' },
            score: { type: 'integer' },
            reason: { type: 'string' }
          },
          required: ['userId', 'name', 'score', 'reason']
        }
      }
    },
    required: ['summary', 'candidates']
  };

  let structured;
  try {
    structured = await requestStructuredJson({
      schema,
      systemPrompt:
        'Voce distribui tarefas em um escritorio de advocacia. ' +
        'Escolha ate 3 responsaveis com base em carga atual, historico e afinidade. ' +
        'Nao invente nomes ou ids fora da lista.',
      userPayload: {
        goal: 'Sugerir os melhores responsaveis para a nova tarefa.',
        taskDraft: { title, description, assignedBy },
        candidates
      }
    });
  } catch (error) {
    structured = null;
  }

  const ranked = sanitizeAssignmentCandidates(structured && structured.candidates, candidates);
  return {
    summary: structured && structured.summary
      ? structured.summary
      : 'Sugestao baseada em perfis por categoria, carga atual, historico de conclusao e afinidade com tarefas semelhantes.',
    candidates: ranked,
    batch: taskBatch.length ? await Promise.all(taskBatch.map(async (task) => {
      const taskTitle = cleanText(task && task.title);
      if (!taskTitle) return null;
      const taskCandidates = (await buildAssignmentCandidates({
        title: taskTitle,
        description: cleanText(task && task.description),
        employees: context.employeeMetrics
      })).slice(0, 3);
      return {
        title: taskTitle,
        description: cleanText(task && task.description),
        candidates: taskCandidates
      };
    })).then((items) => items.filter(Boolean)) : []
  };
}

async function triageInitial(input) {
  ensureAiEnabled();
  const title = cleanText(input && input.title);
  const initialText = cleanText(input && input.initialText);
  const contextNote = cleanText(input && input.contextNote);
  if (!initialText) {
    const error = new Error('Texto da inicial obrigatorio');
    error.status = 400;
    throw error;
  }

  const context = await buildManagerContext({ period: '30d' });
  const employees = context.employeeMetrics.map(toAssignmentProfile);
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      priority: { type: 'string' },
      risks: { type: 'array', items: { type: 'string' } },
      checklist: { type: 'array', items: { type: 'string' } },
      nextSteps: { type: 'array', items: { type: 'string' } },
      suggestedTasks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            assignedToUserId: { type: 'integer' },
            assignedToName: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['title', 'description', 'assignedToUserId', 'assignedToName', 'reason']
        }
      }
    },
    required: ['summary', 'priority', 'risks', 'checklist', 'nextSteps', 'suggestedTasks']
  };

  const result = await requestStructuredJson({
    schema,
    systemPrompt:
      'Voce atua na triagem operacional de iniciais em um escritorio de advocacia. ' +
      'Produza uma resposta objetiva, prudente e operacional. ' +
      'Nao de consultoria juridica definitiva. Use apenas o contexto fornecido.',
    userPayload: {
      goal: 'Triagem operacional de uma inicial com sugestoes de tarefas e responsaveis.',
      initial: {
        title: title || 'Sem titulo',
        text: initialText,
        contextNote
      },
      employees
    }
  });

  return {
    summary: result.summary,
    priority: cleanPriority(result.priority),
    risks: ensureStringArray(result.risks),
    checklist: ensureStringArray(result.checklist),
    nextSteps: ensureStringArray(result.nextSteps),
    suggestedTasks: sanitizeTriageTasks(result.suggestedTasks, context.employeeMetrics)
  };
}

async function runManagerChat(input) {
  ensureAiEnabled();
  const message = cleanText(input && input.message);
  const history = Array.isArray(input && input.history) ? input.history.slice(-8) : [];
  if (!message) {
    const error = new Error('Mensagem obrigatoria');
    error.status = 400;
    throw error;
  }

  const context = await buildManagerContext({ period: '7d' });
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string' },
      reply: { type: 'string' },
      suggestions: { type: 'array', items: { type: 'string' } },
      alerts: { type: 'array', items: { type: 'string' } },
      pendingAction: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          taskId: { type: 'string' },
          reason: { type: 'string' },
          payload: { type: 'object' }
        },
        required: ['type', 'reason', 'payload']
      }
    },
    required: ['mode', 'reply', 'suggestions', 'alerts', 'pendingAction']
  };

  const messages = [];
  history.forEach((item) => {
    if (!item || !item.role || !item.content) return;
    messages.push({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content)
    });
  });
  messages.push({ role: 'user', content: message });

  const result = await requestStructuredJson({
    schema,
    systemPrompt:
      'Voce e um assistente operacional do painel do gestor em um escritorio de advocacia. ' +
      'Responda em portugues, de forma objetiva, pratica e com base apenas nos dados fornecidos. ' +
      'Voce pode preparar acoes estruturadas sobre tarefas, mas nunca executar nada. ' +
      'Quando o pedido for apenas informacional, retorne mode="analysis" e pendingAction.type="none". ' +
      'Quando o pedido pedir criacao, edicao, redistribuicao, mudanca de status ou exclusao de tarefa e houver dados suficientes, retorne mode="action" com pendingAction preenchido. ' +
      'Toda acao exige confirmacao explicita do gestor. ' +
      'Nao invente ids, tarefas ou usuarios. Use somente os ids do contexto. ' +
      'Use um destes tipos de acao: none, create_task, update_task, change_status, reassign_task, delete_task. ' +
      'Para localizar uma tarefa existente, prefira taskId. So use pendingAction quando estiver seguro. Se faltar informacao, faca uma pergunta em reply e deixe pendingAction.type="none". ' +
      'Contexto da equipe: ' + JSON.stringify({
        teamContext: context.meta,
        employees: context.teamMembers,
        employeeMetrics: context.employeeMetrics.map(toChatMetric),
        currentTasks: context.currentTasks
      }),
    messages
  });

  const pendingAction = sanitizePendingAction(result.pendingAction, context);
  const actionPreview = pendingAction ? describePendingAction(pendingAction, context) : null;

  return {
    mode: pendingAction ? 'action' : normalizeChatMode(result.mode),
    reply: result.reply,
    suggestions: ensureStringArray(result.suggestions),
    alerts: ensureStringArray(result.alerts),
    requiresConfirmation: !!pendingAction,
    pendingAction,
    actionPreview
  };
}

async function buildManagerContext(input) {
  const period = cleanPeriod(input && input.period);
  const currentTasks = await query(
    `
      SELECT
        t.id,
        t.title,
        t.description,
        t.assigned_by,
        t.user_id,
        t.status,
        t.elapsed,
        t.timer_start,
        t.completed_at,
        t.needs_revisao,
        t.needs_protocolo,
        t.flag_agendei,
        t.flag_dispensa,
        t.flag_protreal,
        t.flag_naoaplic,
        t.created_at,
        u.name AS emp_name
      FROM tasks t
      JOIN users u ON u.id = t.user_id
      WHERE u.role = 'employee' AND u.is_active = TRUE
      ORDER BY t.created_at DESC
    `
  );

  const employees = await query(
    `
      SELECT id, name
      FROM users
      WHERE role = 'employee' AND is_active = TRUE
      ORDER BY name
    `
  );

  const days = periodToDays(period);
  const historyRows = days
    ? await query(
      `
        SELECT date, closed_at, data
        FROM history_snapshots
        WHERE date >= $1
        ORDER BY date DESC
      `,
      [daysAgo(days)]
    )
    : await query(
      `
        SELECT date, closed_at, data
        FROM history_snapshots
        ORDER BY date DESC
        LIMIT 90
      `
    );

  const snapshots = historyRows.rows.map((row) => ({
    date: row.date,
    closedAt: row.closed_at,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  }));

  const employeeMetrics = employees.rows.map((emp) => {
    const empId = Number(emp.id);
    const currentEmpTasks = currentTasks.rows.filter((task) => Number(task.user_id) === empId);
    const snapshotTasks = [];

    snapshots.forEach((snapshot) => {
      (snapshot.data.employees || []).forEach((item) => {
        if (Number(item.empId) === empId) {
          (item.tasks || []).forEach((task) => snapshotTasks.push(task));
        }
      });
    });

    const allDone = currentEmpTasks
      .filter((task) => task.status === 'done')
      .map(normalizeAiTask)
      .concat(snapshotTasks.filter((task) => task.status === 'done').map(normalizeHistoryTask));

    const keywordsCorpus = currentEmpTasks
      .map((task) => [task.title, task.description].join(' '))
      .concat(snapshotTasks.map((task) => [task.title, task.description].join(' ')))
      .join(' ');

    const averageDoneMs = average(
      allDone
        .map((task) => Number(task.elapsed || 0))
        .filter((elapsed) => elapsed > 0)
    );

    return {
      empId,
      name: emp.name,
      currentOpenCount: currentEmpTasks.filter((task) => task.status !== 'done').length,
      currentDoingCount: currentEmpTasks.filter((task) => task.status === 'doing').length,
      currentDoneCount: currentEmpTasks.filter((task) => task.status === 'done').length,
      historicalDoneCount: snapshotTasks.filter((task) => task.status === 'done').length,
      historicalTaskCount: snapshotTasks.length,
      averageDoneMs: averageDoneMs || 0,
      totalTrackedMs:
        sumDurations(currentEmpTasks.map(normalizeAiTask)) +
        sumDurations(snapshotTasks.map(normalizeHistoryTask)),
      reviewFlags: countFlags(snapshotTasks, 'needsRevisao') + countFlags(currentEmpTasks, 'needs_revisao'),
      protocolFlags: countFlags(snapshotTasks, 'needsProtocolo') + countFlags(currentEmpTasks, 'needs_protocolo'),
      keywordCorpus: keywordsCorpus,
      recentTitles: currentEmpTasks.slice(0, 8).map((task) => task.title)
    };
  });

  return {
    meta: {
      period,
      activeEmployees: employees.rows.length,
      currentTaskCount: currentTasks.rows.length,
      snapshotCount: snapshots.length
    },
    employeeMetrics,
    teamMembers: employees.rows.map((emp) => ({
      userId: Number(emp.id),
      name: emp.name
    })),
    currentTasks: currentTasks.rows.map((task) => ({
      id: String(task.id),
      title: task.title,
      description: task.description,
      assignedBy: task.assigned_by,
      userId: Number(task.user_id),
      empName: task.emp_name,
      status: task.status,
      elapsed: Number(task.elapsed || 0),
      needsRevisao: !!task.needs_revisao,
      needsProtocolo: !!task.needs_protocolo
    })),
    historicalTasks: snapshots.reduce((all, snapshot) => {
      (snapshot.data.employees || []).forEach((item) => {
        (item.tasks || []).forEach((task) => {
          all.push({
            id: String(snapshot.date + ':' + item.empId + ':' + cleanText(task.title)),
            title: task.title,
            description: task.description,
            assignedBy: task.assignedBy,
            userId: Number(item.empId),
            empName: item.empName || 'Colaborador',
            status: task.status,
            elapsed: Number(task.elapsed || 0),
            needsRevisao: !!task.needsRevisao,
            needsProtocolo: !!task.needsProtocolo,
            closedAt: snapshot.closedAt,
            snapshotDate: snapshot.date
          });
        });
      });
      return all;
    }, [])
  };
}

async function requestStructuredJson(input) {
  const apiKey = process.env.GEMINI_API_KEY;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(buildGeminiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(buildGeminiPayload(input)),
      signal: controller.signal
    });

    const payload = await response.json();
    if (!response.ok) {
      const message = payload && payload.error && payload.error.message
        ? payload.error.message
        : 'Falha ao consultar a IA';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const text = extractGeminiText(payload);
    if (!text) {
      const error = new Error('Resposta da IA vazia');
      error.status = 502;
      throw error;
    }

    return JSON.parse(stripCodeFence(text));
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('A IA demorou demais para responder');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildGeminiUrl() {
  return GEMINI_API_URL + '/' + encodeURIComponent(DEFAULT_MODEL) + ':generateContent';
}

function buildGeminiPayload(input) {
  const payload = {
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseJsonSchema: input.schema
    }
  };

  const systemText = cleanText(input.systemPrompt || 'Responda apenas com JSON valido.');
  if (systemText) {
    payload.systemInstruction = {
      role: 'system',
      parts: [{ text: systemText }]
    };
  }

  if (Array.isArray(input.messages) && input.messages.length) {
    payload.contents = input.messages
      .filter((message) => message && message.content && message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(message.content) }]
      }));
  } else {
    payload.contents = [
      {
        role: 'user',
        parts: [{ text: JSON.stringify(input.userPayload || {}) }]
      }
    ];
  }

  return payload;
}

function extractGeminiText(payload) {
  const part = payload
    && payload.candidates
    && payload.candidates[0]
    && payload.candidates[0].content
    && payload.candidates[0].content.parts
    && payload.candidates[0].content.parts[0];

  if (part && typeof part.text === 'string') {
    return part.text;
  }
  return '';
}

function sanitizePendingAction(value, context) {
  const action = value && typeof value === 'object' ? value : {};
  const type = cleanText(action.type).toLowerCase();
  const payload = action.payload && typeof action.payload === 'object' ? action.payload : {};
  const reason = cleanText(action.reason) || 'Acao preparada pelo assistente com base no contexto atual.';
  const employeeById = {};
  const taskById = {};
  const tasksByTitle = {};

  context.teamMembers.forEach((member) => {
    employeeById[member.userId] = member;
  });
  context.currentTasks.forEach((task) => {
    taskById[String(task.id)] = task;
    const titleKey = cleanText(task.title).toLowerCase();
    if (!titleKey) return;
    if (!tasksByTitle[titleKey]) tasksByTitle[titleKey] = [];
    tasksByTitle[titleKey].push(task);
  });

  if (!type || type === 'none') return null;

  if (type === 'create_task') {
    const userId = Number(payload.userId || payload.assignedToUserId);
    const employee = employeeById[userId];
    const title = cleanText(payload.title);
    if (!employee || !title) return null;
    return {
      type,
      taskId: null,
      reason,
      payload: {
        title,
        description: cleanText(payload.description),
        notes: cleanText(payload.notes),
        assignedBy: cleanText(payload.assignedBy),
        userId: employee.userId,
        status: sanitizeTaskStatus(payload.status) || 'todo'
      }
    };
  }

  const task = resolveTaskReference(action.taskId, payload, taskById, tasksByTitle);
  if (!task) return null;

  if (type === 'delete_task') {
    return {
      type,
      taskId: task.id,
      reason,
      payload: {}
    };
  }

  if (type === 'change_status') {
    const newStatus = sanitizeTaskStatus(payload.newStatus || payload.status);
    if (!newStatus) return null;
    return {
      type,
      taskId: task.id,
      reason,
      payload: {
        newStatus,
        needsRevisao: !!payload.needsRevisao,
        needsProtocolo: !!payload.needsProtocolo,
        flagAgendei: !!payload.flagAgendei,
        flagDispensa: !!payload.flagDispensa,
        flagProtreal: !!payload.flagProtreal,
        flagNaoAplic: !!payload.flagNaoAplic
      }
    };
  }

  if (type === 'reassign_task') {
    const userId = Number(payload.userId || payload.assignedToUserId);
    const employee = employeeById[userId];
    if (!employee) return null;
    return {
      type,
      taskId: task.id,
      reason,
      payload: {
        userId: employee.userId,
        assignedBy: cleanText(payload.assignedBy)
      }
    };
  }

  if (type === 'update_task') {
    const nextUserId = payload.userId != null || payload.assignedToUserId != null
      ? Number(payload.userId || payload.assignedToUserId)
      : task.userId;
    const employee = employeeById[nextUserId];
    if (!employee) return null;
    const nextPayload = {};
    if (payload.title != null) nextPayload.title = cleanText(payload.title);
    if (payload.description != null) nextPayload.description = cleanText(payload.description);
    if (payload.notes != null) nextPayload.notes = cleanText(payload.notes);
    if (payload.assignedBy != null) nextPayload.assignedBy = cleanText(payload.assignedBy);
    nextPayload.userId = employee.userId;
    if (!Object.keys(nextPayload).length) return null;
    return {
      type,
      taskId: task.id,
      reason,
      payload: nextPayload
    };
  }

  return null;
}

function resolveTaskReference(taskId, payload, taskById, tasksByTitle) {
  const explicitId = cleanText(taskId || payload.taskId);
  if (explicitId && taskById[explicitId]) return taskById[explicitId];

  const titleRef = cleanText(payload.targetTitle || payload.currentTitle || payload.title).toLowerCase();
  if (!titleRef || !tasksByTitle[titleRef] || tasksByTitle[titleRef].length !== 1) return null;
  return tasksByTitle[titleRef][0];
}

function describePendingAction(action, context) {
  const task = action.taskId
    ? context.currentTasks.filter((item) => String(item.id) === String(action.taskId))[0]
    : null;
  const employeeById = {};
  context.teamMembers.forEach((member) => {
    employeeById[member.userId] = member;
  });
  const nextOwner = employeeById[Number(action.payload && action.payload.userId)];
  const labels = {
    create_task: 'Criar tarefa',
    update_task: 'Atualizar tarefa',
    change_status: 'Alterar status',
    reassign_task: 'Redistribuir tarefa',
    delete_task: 'Excluir tarefa'
  };
  let summary = action.reason || '';

  if (action.type === 'create_task') {
    summary =
      'Criar "' + action.payload.title + '" para ' +
      (nextOwner ? nextOwner.name : 'responsavel selecionado') +
      (action.payload.status && action.payload.status !== 'todo' ? ' com status ' + formatTaskStatus(action.payload.status) : '.');
  } else if (action.type === 'update_task' && task) {
    summary = 'Atualizar "' + task.title + '"' + (nextOwner && nextOwner.userId !== task.userId ? ' e mover para ' + nextOwner.name : '.') ;
  } else if (action.type === 'change_status' && task) {
    summary = 'Mover "' + task.title + '" para ' + formatTaskStatus(action.payload.newStatus) + '.';
  } else if (action.type === 'reassign_task' && task) {
    summary = 'Reatribuir "' + task.title + '" para ' + (nextOwner ? nextOwner.name : 'o novo responsavel') + '.';
  } else if (action.type === 'delete_task' && task) {
    summary = 'Excluir "' + task.title + '" de ' + task.empName + '.';
  }

  return {
    label: labels[action.type] || 'Acao do assistente',
    summary,
    currentTaskTitle: task ? task.title : null,
    currentAssignee: task ? task.empName : null,
    nextAssignee: nextOwner ? nextOwner.name : null,
    nextStatus: action.payload && action.payload.newStatus ? action.payload.newStatus : null
  };
}

function toChatMetric(metric) {
  return {
    empId: metric.empId,
    name: metric.name,
    currentOpenCount: metric.currentOpenCount,
    currentDoingCount: metric.currentDoingCount,
    currentDoneCount: metric.currentDoneCount,
    historicalDoneCount: metric.historicalDoneCount,
    averageDoneMs: metric.averageDoneMs,
    reviewFlags: metric.reviewFlags,
    protocolFlags: metric.protocolFlags,
    recentTitles: metric.recentTitles.slice(0, 5)
  };
}

function normalizeChatMode(value) {
  return cleanText(value).toLowerCase() === 'action' ? 'action' : 'analysis';
}

function stripCodeFence(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('```')) return text;
  return text
    .replace(/^```[a-zA-Z0-9_-]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}

function sanitizeEmployeeFeedback(items, metrics) {
  const byId = {};
  metrics.forEach((item) => { byId[item.empId] = item; });
  return (Array.isArray(items) ? items : []).map((item) => ({
    empId: Number(item.empId),
    name: item.name || (byId[Number(item.empId)] ? byId[Number(item.empId)].name : 'Colaborador'),
    scoreLabel: item.scoreLabel || 'Neutro',
    feedback: item.feedback || 'Sem feedback gerado.',
    risk: item.risk || 'Sem riscos relevantes identificados.',
    nextStep: item.nextStep || 'Acompanhar execucao.'
  }));
}

function sanitizeAssignmentCandidates(items, fallback) {
  const fallbackById = {};
  fallback.forEach((item) => { fallbackById[item.userId] = item; });
  const source = Array.isArray(items) && items.length
    ? items.filter((item) => fallbackById[Number(item.userId)])
    : fallback;
  const seen = {};

  return source
    .map((item) => {
      const base = fallbackById[Number(item.userId)] || item;
      return {
        userId: Number(base.userId),
        name: base.name,
        score: clampScore(item.score != null ? item.score : base.score),
        reason: cleanText(item.reason) || base.reason
      };
    })
    .filter((item) => item.userId && !seen[item.userId] && (seen[item.userId] = true))
    .slice(0, 3);
}

function sanitizeTriageTasks(items, metrics) {
  const profiles = metrics.map(toAssignmentProfile);
  const byId = {};
  profiles.forEach((item) => { byId[item.userId] = item; });
  return (Array.isArray(items) ? items : []).map((item) => {
    const chosen = byId[Number(item.assignedToUserId)] || profiles[0] || null;
    return {
      title: cleanText(item.title) || 'Tarefa sugerida',
      description: cleanText(item.description) || 'Detalhar execucao conforme triagem.',
      assignedToUserId: chosen ? chosen.userId : null,
      assignedToName: chosen ? chosen.name : 'Sem responsavel',
      reason: cleanText(item.reason) || 'Sugestao da IA'
    };
  }).filter((item) => item.assignedToUserId);
}

async function buildAssignmentCandidates(input) {
  const persisted = await rankAssignmentCandidatesFromProfiles(input);
  if (persisted.length) {
    return persisted;
  }
  return rankAssignmentCandidates(input);
}

async function rankAssignmentCandidatesFromProfiles(input) {
  const categories = detectAssignmentCategories(input.title, input.description);
  if (!categories.length) return [];

  const result = await query(
    `
      SELECT
        employee_id,
        employee_name,
        category,
        category_label,
        score,
        confidence,
        done_count,
        open_count,
        doing_count,
        avg_done_ms
      FROM ai_performance_profiles
      WHERE category = ANY($1::text[])
    `,
    [categories]
  ).catch(() => ({ rows: [] }));

  if (!result.rows.length) return [];

  const grouped = {};
  result.rows.forEach((row) => {
    const empId = Number(row.employee_id);
    if (!grouped[empId]) {
      grouped[empId] = {
        userId: empId,
        name: row.employee_name,
        score: 0,
        reasons: [],
        confidence: 0
      };
    }

    grouped[empId].score += Number(row.score || 0);
    grouped[empId].confidence += Number(row.confidence || 0);
    grouped[empId].reasons.push(
      row.category_label + ': score ' + row.score +
      ', ' + row.done_count + ' concluida(s), ' +
      row.open_count + ' aberta(s), ' +
      row.doing_count + ' em andamento.'
    );
  });

  return Object.keys(grouped).map((key) => {
    const item = grouped[key];
    return {
      userId: item.userId,
      name: item.name,
      score: clampScore(Math.round(item.score / Math.max(categories.length, 1))),
      reason: 'Perfis por categoria: ' + item.reasons.join(' ')
    };
  }).sort((a, b) => b.score - a.score);
}

function detectAssignmentCategories(title, description) {
  const text = (cleanText(title) + ' ' + cleanText(description)).toLowerCase();
  const rules = [
    { category: 'protocolo', keywords: ['protocolo', 'protocolar', 'peticionamento', 'distribuicao'] },
    { category: 'revisao', keywords: ['revisao', 'revisar', 'validar', 'corrigir'] },
    { category: 'cumprimento', keywords: ['cumprimento', 'mandado', 'oficio', 'intimacao', 'prazo'] },
    { category: 'peticao', keywords: ['peticao', 'manifestacao', 'contestacao', 'recurso', 'impugnacao'] },
    { category: 'audiencia', keywords: ['audiencia', 'sessao', 'pauta'] },
    { category: 'atendimento', keywords: ['cliente', 'atendimento', 'retorno', 'ligacao'] },
    { category: 'financeiro', keywords: ['custas', 'guia', 'pagamento', 'deposito'] },
    { category: 'administrativo', keywords: ['cadastro', 'arquivo', 'planilha', 'controle', 'relatorio'] }
  ];

  const matches = rules
    .filter((rule) => rule.keywords.some((keyword) => text.indexOf(keyword) !== -1))
    .map((rule) => rule.category);

  return matches.length ? matches.slice(0, 2) : ['administrativo'];
}

function rankAssignmentCandidates(input) {
  const text = (input.title + ' ' + input.description).toLowerCase();
  const tokens = uniqueTokens(text);

  return input.employees.map((emp) => {
    const keywordHits = tokens.reduce((sum, token) => {
      return sum + (emp.keywordCorpus.toLowerCase().indexOf(token) !== -1 ? 1 : 0);
    }, 0);
    const avgMinutes = emp.averageDoneMs ? Math.round(emp.averageDoneMs / 60000) : 0;
    const score =
      70 +
      Math.min(emp.historicalDoneCount, 20) * 2 +
      keywordHits * 5 -
      emp.currentOpenCount * 4 -
      emp.currentDoingCount * 6 -
      Math.min(avgMinutes, 180) / 6;

    return {
      userId: emp.empId,
      name: emp.name,
      score: clampScore(Math.round(score)),
      reason:
        'Carga atual: ' + emp.currentOpenCount + ' aberta(s), ' +
        emp.currentDoingCount + ' em andamento; ' +
        emp.historicalDoneCount + ' concluida(s) no historico; ' +
        keywordHits + ' sinal(is) de afinidade.'
    };
  }).sort((a, b) => b.score - a.score);
}

function toAssignmentProfile(metric) {
  return {
    userId: metric.empId,
    name: metric.name,
    currentOpenCount: metric.currentOpenCount,
    currentDoingCount: metric.currentDoingCount,
    historicalDoneCount: metric.historicalDoneCount,
    averageDoneMs: metric.averageDoneMs,
    recentTitles: metric.recentTitles.slice(0, 5)
  };
}

function normalizeAiTask(task) {
  return {
    title: task.title,
    description: task.description,
    elapsed: Number(task.elapsed || 0) + (task.timer_start ? (Date.now() - Number(task.timer_start)) : 0),
    status: task.status,
    needsRevisao: !!task.needs_revisao,
    needsProtocolo: !!task.needs_protocolo
  };
}

function normalizeHistoryTask(task) {
  return {
    title: task.title,
    description: task.description,
    elapsed: Number(task.elapsed || 0),
    status: task.status,
    needsRevisao: !!task.needsRevisao,
    needsProtocolo: !!task.needsProtocolo
  };
}

function cleanText(value) {
  return String(value || '').trim();
}

function cleanPriority(value) {
  const valid = ['baixa', 'media', 'alta', 'critica'];
  const normalized = cleanText(value).toLowerCase();
  return valid.indexOf(normalized) !== -1 ? normalized : 'media';
}

function cleanPeriod(value) {
  return ['today', '7d', '30d', 'history'].indexOf(value) !== -1 ? value : '7d';
}

function periodToDays(value) {
  if (value === 'today') return 1;
  if (value === '7d') return 7;
  if (value === '30d') return 30;
  return null;
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumDurations(tasks) {
  return tasks.reduce((sum, task) => sum + Number(task.elapsed || 0), 0);
}

function countFlags(tasks, key) {
  return tasks.filter((task) => !!task[key]).length;
}

function uniqueTokens(text) {
  const seen = {};
  return String(text || '')
    .split(/[^a-z0-9áéíóúàâêôãõç]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4)
    .filter((item) => !seen[item] && (seen[item] = true))
    .slice(0, 16);
}

function clampScore(value) {
  const num = Number(value || 0);
  if (num < 1) return 1;
  if (num > 100) return 100;
  return Math.round(num);
}

function sanitizeTaskStatus(value) {
  const status = cleanText(value).toLowerCase();
  return ['todo', 'doing', 'done'].indexOf(status) !== -1 ? status : '';
}

function formatTaskStatus(value) {
  return {
    todo: 'A Fazer',
    doing: 'Em andamento',
    done: 'Concluida'
  }[value] || value;
}

function ensureStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item)).filter(Boolean)
    : [];
}

module.exports = {
  buildManagerContext,
  generateFeedback,
  isAiEnabled,
  requestStructuredJson,
  runManagerChat,
  suggestTaskAssignment,
  triageInitial
};
