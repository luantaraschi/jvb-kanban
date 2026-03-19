'use strict';

const { buildManagerContext, isAiEnabled, requestStructuredJson } = require('./ai');
const { query, withTransaction } = require('./db');
const { extractPdfText, uploadPendingPdf } = require('./storage');

const DEFAULT_REPORT_PERIOD = '7d';

const CATEGORY_DEFS = [
  { key: 'protocolo', label: 'Protocolo', keywords: ['protocolo', 'protocolar', 'protocole', 'peticionamento', 'distribuicao'] },
  { key: 'revisao', label: 'Revisao', keywords: ['revisao', 'revisar', 'conferencia', 'corrigir', 'validar'] },
  { key: 'cumprimento', label: 'Cumprimento', keywords: ['cumprimento', 'mandado', 'oficio', 'intimacao', 'prazo'] },
  { key: 'peticao', label: 'Peticao', keywords: ['peticao', 'manifestacao', 'contestacao', 'recurso', 'contrarrazoes', 'impugnacao'] },
  { key: 'audiencia', label: 'Audiencia', keywords: ['audiencia', 'sustentacao', 'sessao', 'pauta'] },
  { key: 'atendimento', label: 'Atendimento', keywords: ['cliente', 'atendimento', 'retorno', 'ligacao', 'whatsapp'] },
  { key: 'financeiro', label: 'Financeiro', keywords: ['custas', 'guia', 'pagamento', 'financeiro', 'deposito'] },
  { key: 'administrativo', label: 'Administrativo', keywords: ['cadastro', 'documento', 'arquivo', 'planilha', 'controle', 'relatorio'] }
];

async function refreshOperationalIntelligence(input) {
  const period = cleanPeriod(input && input.period);
  const source = cleanText(input && input.source) || 'manual';
  const createdByUserId = input && input.createdByUserId ? Number(input.createdByUserId) : null;
  const context = await buildManagerContext({ period });
  const profiles = computePerformanceProfiles(context);
  const heuristic = buildHeuristicSnapshot({ context, period, profiles, source });
  const enriched = isAiEnabled()
    ? await buildAiSnapshot({ context, heuristic, period }).catch(function () { return null; })
    : null;

  const snapshot = normalizeReportSnapshot({
    period,
    source,
    createdByUserId,
    context,
    heuristic,
    enriched,
    profiles
  });

  const persisted = await withTransaction(async (client) => {
    const reportResult = await client.query(
      `
        INSERT INTO ai_report_snapshots (
          period,
          source,
          created_by_user_id,
          report_json
        )
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING id, generated_at
      `,
      [period, source, createdByUserId, JSON.stringify(snapshot)]
    );

    const snapshotId = Number(reportResult.rows[0].id);
    for (const profile of profiles) {
      await client.query(
        `
          INSERT INTO ai_performance_profiles (
            employee_id,
            employee_name,
            category,
            category_label,
            score,
            confidence,
            sample_size,
            done_count,
            open_count,
            doing_count,
            avg_done_ms,
            review_rate,
            protocol_rate,
            keyword_hits,
            metrics_json,
            source_snapshot_id
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16
          )
          ON CONFLICT (employee_id, category)
          DO UPDATE SET
            employee_name = EXCLUDED.employee_name,
            category_label = EXCLUDED.category_label,
            score = EXCLUDED.score,
            confidence = EXCLUDED.confidence,
            sample_size = EXCLUDED.sample_size,
            done_count = EXCLUDED.done_count,
            open_count = EXCLUDED.open_count,
            doing_count = EXCLUDED.doing_count,
            avg_done_ms = EXCLUDED.avg_done_ms,
            review_rate = EXCLUDED.review_rate,
            protocol_rate = EXCLUDED.protocol_rate,
            keyword_hits = EXCLUDED.keyword_hits,
            metrics_json = EXCLUDED.metrics_json,
            source_snapshot_id = EXCLUDED.source_snapshot_id,
            updated_at = NOW()
        `,
        [
          profile.empId,
          profile.name,
          profile.category,
          profile.categoryLabel,
          profile.score,
          profile.confidence,
          profile.sampleSize,
          profile.doneCount,
          profile.openCount,
          profile.doingCount,
          profile.avgDoneMs,
          profile.reviewRate,
          profile.protocolRate,
          profile.keywordHits,
          JSON.stringify(profile),
          snapshotId
        ]
      );
    }

    await persistAiRun(client, {
      kind: 'report_snapshot',
      createdByUserId,
      inputJson: { period, source },
      outputJson: snapshot,
      status: 'completed'
    });

    return {
      id: snapshotId,
      generatedAt: reportResult.rows[0].generated_at
    };
  });

  snapshot.id = persisted.id;
  snapshot.generatedAt = persisted.generatedAt;
  return snapshot;
}

async function getLatestOperationalReport(input) {
  const period = cleanPeriod(input && input.period);
  const result = await query(
    `
      SELECT id, period, source, created_by_user_id, report_json, generated_at
      FROM ai_report_snapshots
      WHERE period = $1
      ORDER BY generated_at DESC
      LIMIT 1
    `,
    [period]
  );

  const row = result.rows[0];
  if (!row) return null;
  const snapshot = typeof row.report_json === 'string' ? JSON.parse(row.report_json) : row.report_json;
  snapshot.id = Number(row.id);
  snapshot.period = row.period;
  snapshot.source = row.source;
  snapshot.createdByUserId = row.created_by_user_id == null ? null : Number(row.created_by_user_id);
  snapshot.generatedAt = row.generated_at;
  return snapshot;
}

async function listPerformanceProfiles() {
  const result = await query(
    `
      SELECT
        employee_id,
        employee_name,
        category,
        category_label,
        score,
        confidence,
        sample_size,
        done_count,
        open_count,
        doing_count,
        avg_done_ms,
        review_rate,
        protocol_rate,
        keyword_hits,
        metrics_json,
        updated_at
      FROM ai_performance_profiles
      ORDER BY employee_name ASC, score DESC, category ASC
    `
  );

  const grouped = {};
  let latestUpdatedAt = null;

  result.rows.forEach(function (row) {
    const empId = Number(row.employee_id);
    if (!grouped[empId]) {
      grouped[empId] = {
        empId: empId,
        name: row.employee_name,
        profiles: []
      };
    }

    grouped[empId].profiles.push({
      category: row.category,
      categoryLabel: row.category_label,
      score: Number(row.score || 0),
      confidence: Number(row.confidence || 0),
      sampleSize: Number(row.sample_size || 0),
      doneCount: Number(row.done_count || 0),
      openCount: Number(row.open_count || 0),
      doingCount: Number(row.doing_count || 0),
      avgDoneMs: Number(row.avg_done_ms || 0),
      reviewRate: Number(row.review_rate || 0),
      protocolRate: Number(row.protocol_rate || 0),
      keywordHits: Number(row.keyword_hits || 0),
      metrics: typeof row.metrics_json === 'string' ? JSON.parse(row.metrics_json) : row.metrics_json
    });

    if (!latestUpdatedAt || new Date(row.updated_at) > new Date(latestUpdatedAt)) {
      latestUpdatedAt = row.updated_at;
    }
  });

  return {
    updatedAt: latestUpdatedAt,
    employees: Object.keys(grouped).map(function (key) { return grouped[key]; })
  };
}

async function createPendingDocument(input) {
  const filename = cleanText(input && input.filename) || 'pendencias.pdf';
  const mimeType = cleanText(input && input.mimeType) || 'application/pdf';
  const contentBase64 = cleanBase64(input && input.contentBase64);
  const createdByUserId = Number(input && input.createdByUserId);

  if (!contentBase64) {
    throw httpError(400, 'Conteudo do PDF obrigatorio');
  }

  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) {
    throw httpError(400, 'Arquivo PDF invalido');
  }

  const documentId = createDocumentId();
  const extractedText = await extractPdfText({ buffer: buffer });
  if (!extractedText) {
    throw httpError(400, 'Nao foi possivel extrair texto do PDF');
  }

  const storage = await uploadPendingPdf({
    documentId: documentId,
    filename: filename,
    mimeType: mimeType,
    buffer: buffer
  });

  const result = await query(
    `
      INSERT INTO ai_pending_documents (
        id,
        filename,
        mime_type,
        file_size,
        storage_bucket,
        storage_path,
        storage_status,
        extracted_text,
        status,
        created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'uploaded', $9)
      RETURNING *
    `,
    [
      documentId,
      filename,
      mimeType,
      buffer.length,
      storage.bucket,
      storage.path,
      storage.storageStatus,
      extractedText,
      createdByUserId
    ]
  );

  await persistAiRunDirect({
    kind: 'pdf_intake',
    createdByUserId: createdByUserId,
    inputJson: { filename: filename, mimeType: mimeType, fileSize: buffer.length },
    outputJson: { documentId: documentId, storageStatus: storage.storageStatus },
    status: 'completed'
  });

  return normalizePendingDocument(result.rows[0]);
}

async function listPendingDocuments() {
  const result = await query(
    `
      SELECT *
      FROM ai_pending_documents
      ORDER BY created_at DESC
      LIMIT 30
    `
  );

  return result.rows.map(normalizePendingDocument);
}

async function getPendingDocument(documentId) {
  const result = await query(
    `
      SELECT *
      FROM ai_pending_documents
      WHERE id = $1
      LIMIT 1
    `,
    [documentId]
  );

  const row = result.rows[0];
  if (!row) return null;

  const suggestions = await query(
    `
      SELECT
        id,
        document_id,
        sort_order,
        title,
        description,
        assigned_to_user_id,
        assigned_to_name,
        category,
        priority,
        reason,
        payload_json
      FROM ai_pending_document_suggestions
      WHERE document_id = $1
      ORDER BY sort_order ASC, created_at ASC
    `,
    [documentId]
  );

  const doc = normalizePendingDocument(row);
  doc.suggestions = suggestions.rows.map(function (item) {
    return {
      id: Number(item.id),
      documentId: item.document_id,
      sortOrder: Number(item.sort_order || 0),
      title: item.title,
      description: item.description,
      assignedToUserId: Number(item.assigned_to_user_id),
      assignedToName: item.assigned_to_name,
      category: item.category,
      priority: item.priority,
      reason: item.reason,
      payload: typeof item.payload_json === 'string' ? JSON.parse(item.payload_json) : item.payload_json
    };
  });
  return doc;
}

async function analyzePendingDocument(input) {
  const documentId = cleanText(input && input.documentId);
  const createdByUserId = Number(input && input.createdByUserId);
  const document = await getPendingDocument(documentId);
  if (!document) {
    throw httpError(404, 'Documento nao encontrado');
  }

  const profilesState = await listPerformanceProfiles();
  if (!profilesState.employees.length) {
    await refreshOperationalIntelligence({
      period: '30d',
      source: 'pdf_primer',
      createdByUserId: createdByUserId
    });
  }

  const profiles = await listPerformanceProfiles();
  const context = await buildManagerContext({ period: '30d' });
  const candidateProfiles = flattenProfiles(profiles.employees);
  const aiOutput = isAiEnabled()
    ? await requestStructuredJson({
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          priority: { type: 'string' },
          alerts: { type: 'array', items: { type: 'string' } },
          checklist: { type: 'array', items: { type: 'string' } },
          suggestedTasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                category: { type: 'string' },
                assignedToUserId: { type: 'integer' },
                assignedToName: { type: 'string' },
                priority: { type: 'string' },
                reason: { type: 'string' }
              },
              required: ['title', 'description', 'category', 'assignedToUserId', 'assignedToName', 'priority', 'reason']
            }
          }
        },
        required: ['summary', 'priority', 'alerts', 'checklist', 'suggestedTasks']
      },
      systemPrompt:
        'Voce analisa PDFs de pendencias operacionais de um escritorio de advocacia. ' +
        'Responda em portugues, de forma objetiva e prudente. ' +
        'Nao invente usuarios fora da lista. Sugira tarefas praticas e responsaveis com base nos perfis de desempenho.',
      userPayload: {
        goal: 'Gerar triagem operacional e sugestoes de designacao a partir do PDF de pendencias.',
        document: {
          id: document.id,
          filename: document.filename,
          extractedText: document.extractedText.slice(0, 18000)
        },
        profiles: candidateProfiles,
        teamContext: context.meta
      }
    }).catch(function () { return null; })
    : null;

  const normalizedAnalysis = normalizeDocumentAnalysis({
    document: document,
    aiOutput: aiOutput,
    profiles: candidateProfiles
  });

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE ai_pending_documents
        SET
          status = 'analyzed',
          analysis_json = $1::jsonb,
          analyzed_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
      `,
      [JSON.stringify(normalizedAnalysis), document.id]
    );

    await client.query('DELETE FROM ai_pending_document_suggestions WHERE document_id = $1', [document.id]);

    for (let index = 0; index < normalizedAnalysis.suggestedTasks.length; index += 1) {
      const suggestion = normalizedAnalysis.suggestedTasks[index];
      await client.query(
        `
          INSERT INTO ai_pending_document_suggestions (
            document_id,
            sort_order,
            title,
            description,
            assigned_to_user_id,
            assigned_to_name,
            category,
            priority,
            reason,
            payload_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        `,
        [
          document.id,
          index,
          suggestion.title,
          suggestion.description,
          suggestion.assignedToUserId,
          suggestion.assignedToName,
          suggestion.category,
          suggestion.priority,
          suggestion.reason,
          JSON.stringify(suggestion.payload || {})
        ]
      );
    }
  });

  await persistAiRunDirect({
    kind: 'pdf_analysis',
    createdByUserId: createdByUserId,
    inputJson: { documentId: document.id, filename: document.filename },
    outputJson: normalizedAnalysis,
    status: 'completed'
  });

  return getPendingDocument(document.id);
}

function computePerformanceProfiles(context) {
  const grouped = {};
  const activeTasks = (context.currentTasks || []).concat(context.historicalTasks || []);

  activeTasks.forEach(function (task) {
    const empId = Number(task.userId || task.empId);
    if (!empId) return;
    const categories = detectCategories(task.title, task.description);
    categories.forEach(function (category) {
      const key = empId + ':' + category;
      if (!grouped[key]) {
        const categoryDef = getCategoryDef(category);
        grouped[key] = {
          empId: empId,
          name: task.empName || findMetricName(context, empId),
          category: category,
          categoryLabel: categoryDef.label,
          sampleSize: 0,
          doneCount: 0,
          openCount: 0,
          doingCount: 0,
          totalDoneMs: 0,
          reviewHits: 0,
          protocolHits: 0,
          keywordHits: 0
        };
      }

      const bucket = grouped[key];
      bucket.sampleSize += 1;
      bucket.keywordHits += scoreKeywordHits(category, task.title, task.description);

      if (task.status === 'done') {
        bucket.doneCount += 1;
        bucket.totalDoneMs += Number(task.elapsed || 0);
      } else {
        bucket.openCount += 1;
      }
      if (task.status === 'doing') bucket.doingCount += 1;
      if (task.needsRevisao) bucket.reviewHits += 1;
      if (task.needsProtocolo) bucket.protocolHits += 1;
    });
  });

  return Object.keys(grouped).map(function (key) {
    const item = grouped[key];
    const avgDoneMs = item.doneCount ? Math.round(item.totalDoneMs / item.doneCount) : 0;
    const reviewRate = item.sampleSize ? round2(item.reviewHits / item.sampleSize) : 0;
    const protocolRate = item.sampleSize ? round2(item.protocolHits / item.sampleSize) : 0;
    const confidence = Math.min(100, 35 + item.sampleSize * 12 + item.doneCount * 6);
    const scoreBase =
      60 +
      item.doneCount * 7 +
      Math.min(item.keywordHits, 10) * 2 -
      item.openCount * 3 -
      item.doingCount * 4 -
      Math.round(avgDoneMs / 60000 / 8) -
      Math.round(reviewRate * 18) -
      Math.round(protocolRate * 10);

    return {
      empId: item.empId,
      name: item.name,
      category: item.category,
      categoryLabel: item.categoryLabel,
      score: clampScore(scoreBase),
      confidence: Math.max(1, Math.round(confidence)),
      sampleSize: item.sampleSize,
      doneCount: item.doneCount,
      openCount: item.openCount,
      doingCount: item.doingCount,
      avgDoneMs: avgDoneMs,
      reviewRate: reviewRate,
      protocolRate: protocolRate,
      keywordHits: item.keywordHits
    };
  }).sort(function (a, b) {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return b.score - a.score;
  });
}

function buildHeuristicSnapshot(input) {
  const context = input.context;
  const profiles = input.profiles;
  const metrics = context.employeeMetrics || [];
  const activeMembers = (context.teamMembers || []).length;
  const overloaded = metrics
    .filter(function (item) { return item.currentOpenCount >= 5 || item.currentDoingCount >= 3; })
    .sort(function (a, b) { return (b.currentOpenCount + b.currentDoingCount * 2) - (a.currentOpenCount + a.currentDoingCount * 2); })
    .slice(0, 5)
    .map(function (item) {
      return {
        empId: item.empId,
        name: item.name,
        openCount: item.currentOpenCount,
        doingCount: item.currentDoingCount,
        risk: item.currentDoingCount >= 3 ? 'alto' : 'moderado'
      };
    });

  const topSpecialists = CATEGORY_DEFS.map(function (categoryDef) {
    const leaders = profiles
      .filter(function (profile) { return profile.category === categoryDef.key; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 3)
      .map(function (profile) {
        return {
          empId: profile.empId,
          name: profile.name,
          score: profile.score,
          confidence: profile.confidence,
          doneCount: profile.doneCount,
          avgDoneMs: profile.avgDoneMs
        };
      });
    return { category: categoryDef.key, categoryLabel: categoryDef.label, leaders: leaders };
  }).filter(function (item) { return item.leaders.length; });

  const redistributionCandidates = (context.currentTasks || [])
    .filter(function (task) { return task.status !== 'done'; })
    .map(function (task) {
      const categories = detectCategories(task.title, task.description);
      const candidate = pickBestProfileForCategories(profiles, categories, Number(task.userId));
      if (!candidate || candidate.empId === Number(task.userId)) return null;
      return {
        taskId: String(task.id),
        title: task.title,
        currentAssignee: task.empName,
        suggestedAssignee: candidate.name,
        suggestedUserId: candidate.empId,
        reason:
          candidate.name + ' tem score ' + candidate.score + ' em ' +
          categories.map(function (cat) { return getCategoryDef(cat).label; }).join(', ') + '.'
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  const recommendations = [];
  if (overloaded.length) {
    recommendations.push('Redistribuir tarefas de ' + overloaded[0].name + ' para reduzir gargalos imediatos.');
  }
  if (!topSpecialists.length) {
    recommendations.push('Ainda nao ha historico suficiente para perfis por categoria com boa confianca.');
  } else {
    recommendations.push('Usar os perfis por categoria como primeira camada para distribuicao assistida.');
  }

  return {
    summary:
      'Equipe com ' + activeMembers + ' colaborador(es) ativo(s), ' +
      context.meta.currentTaskCount + ' tarefa(s) no board e ' +
      topSpecialists.length + ' categoria(s) com ranking disponivel.',
    alerts: overloaded.length
      ? overloaded.map(function (item) {
        return item.name + ' esta com ' + item.openCount + ' aberta(s) e ' + item.doingCount + ' em andamento.';
      })
      : ['Nenhum gargalo forte detectado na carga atual.'],
    recommendations: recommendations,
    overloadedEmployees: overloaded,
    topSpecialists: topSpecialists,
    redistributionCandidates: redistributionCandidates
  };
}

async function buildAiSnapshot(input) {
  const payload = await requestStructuredJson({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        executiveSummary: { type: 'string' },
        alerts: { type: 'array', items: { type: 'string' } },
        recommendations: { type: 'array', items: { type: 'string' } },
        loadNotes: { type: 'array', items: { type: 'string' } },
        specialistHighlights: { type: 'array', items: { type: 'string' } }
      },
      required: ['executiveSummary', 'alerts', 'recommendations', 'loadNotes', 'specialistHighlights']
    },
    systemPrompt:
      'Voce gera inteligencia operacional para um escritorio de advocacia. ' +
      'Responda apenas com JSON valido, em portugues, sem inventar fatos. ' +
      'Use a heuristica fornecida para resumir gargalos, especialidades e redistribuicoes.',
    userPayload: {
      goal: 'Resumir a operacao da equipe e apontar especialistas por categoria.',
      period: input.period,
      teamContext: input.context.meta,
      heuristic: input.heuristic
    }
  });

  return {
    executiveSummary: cleanText(payload.executiveSummary),
    alerts: cleanStringArray(payload.alerts),
    recommendations: cleanStringArray(payload.recommendations),
    loadNotes: cleanStringArray(payload.loadNotes),
    specialistHighlights: cleanStringArray(payload.specialistHighlights)
  };
}

function normalizeReportSnapshot(input) {
  return {
    period: input.period,
    source: input.source,
    createdByUserId: input.createdByUserId,
    generatedAt: new Date().toISOString(),
    enabled: isAiEnabled(),
    meta: input.context.meta,
    executiveSummary: (input.enriched && input.enriched.executiveSummary) || input.heuristic.summary,
    alerts: mergeUnique(input.heuristic.alerts, input.enriched && input.enriched.alerts),
    recommendations: mergeUnique(input.heuristic.recommendations, input.enriched && input.enriched.recommendations),
    loadNotes: mergeUnique([], input.enriched && input.enriched.loadNotes),
    specialistHighlights: mergeUnique([], input.enriched && input.enriched.specialistHighlights),
    overloadedEmployees: input.heuristic.overloadedEmployees,
    topSpecialists: input.heuristic.topSpecialists,
    redistributionCandidates: input.heuristic.redistributionCandidates,
    feedback: buildFeedbackFromSnapshot(input)
  };
}

function buildFeedbackFromSnapshot(input) {
  return {
    period: input.period,
    contextMeta: input.context.meta,
    summary: (input.enriched && input.enriched.executiveSummary) || input.heuristic.summary,
    teamHighlights: input.heuristic.topSpecialists.slice(0, 3).map(function (item) {
      return item.categoryLabel + ': ' + item.leaders.map(function (leader) { return leader.name; }).join(', ');
    }),
    bottlenecks: input.heuristic.alerts,
    recommendations: input.heuristic.recommendations,
    employees: (input.context.employeeMetrics || []).map(function (metric) {
      const bestProfile = input.profiles
        .filter(function (profile) { return profile.empId === metric.empId; })
        .sort(function (a, b) { return b.score - a.score; })[0];
      return {
        empId: metric.empId,
        name: metric.name,
        scoreLabel: bestProfile
          ? bestProfile.categoryLabel + ' · score ' + bestProfile.score
          : 'Sem base historica suficiente',
        feedback:
          metric.currentOpenCount + ' aberta(s), ' +
          metric.currentDoingCount + ' em andamento, ' +
          metric.historicalDoneCount + ' concluida(s) no historico.',
        risk: metric.currentDoingCount >= 3 ? 'Sobrecarga imediata' : metric.currentOpenCount >= 5 ? 'Fila alta' : 'Controlado',
        nextStep: bestProfile
          ? 'Priorizar atividades de ' + bestProfile.categoryLabel.toLowerCase() + ' quando possivel.'
          : 'Ampliar historico para ranqueamento por categoria.'
      };
    })
  };
}

function normalizeDocumentAnalysis(input) {
  const aiOutput = input.aiOutput || {};
  const profiles = input.profiles || [];
  const rawSuggested = Array.isArray(aiOutput.suggestedTasks) ? aiOutput.suggestedTasks : [];

  const suggestedTasks = rawSuggested.length
    ? rawSuggested.map(function (task) {
      const category = normalizeCategory(task.category || detectCategories(task.title, task.description)[0]);
      const assignedUserId = Number(task.assignedToUserId);
      const fallbackProfile = assignedUserId
        ? findProfileByUserAndCategory(profiles, assignedUserId, category)
        : pickBestProfileForCategories(profiles, [category], null);
      return {
        title: cleanText(task.title) || 'Tarefa sugerida',
        description: cleanText(task.description) || 'Gerada a partir do PDF de pendencias.',
        category: category,
        priority: cleanPriority(task.priority),
        assignedToUserId: fallbackProfile ? fallbackProfile.empId : null,
        assignedToName: fallbackProfile ? fallbackProfile.name : 'Sem responsavel',
        reason: cleanText(task.reason) || (fallbackProfile
          ? 'Sugestao baseada no perfil de ' + fallbackProfile.categoryLabel.toLowerCase() + '.'
          : 'Sugestao da IA'),
        payload: {
          assignedBy: 'Assistente IA',
          status: 'todo'
        }
      };
    }).filter(function (item) { return item.assignedToUserId; })
    : buildFallbackDocumentTasks(input.document, profiles);

  return {
    summary: cleanText(aiOutput.summary) || 'Triagem operacional gerada a partir do PDF de pendencias.',
    priority: cleanPriority(aiOutput.priority),
    alerts: cleanStringArray(aiOutput.alerts),
    checklist: cleanStringArray(aiOutput.checklist),
    suggestedTasks: suggestedTasks
  };
}

function buildFallbackDocumentTasks(document, profiles) {
  const lines = document.extractedText
    .split(/\n+/)
    .map(function (line) { return cleanText(line); })
    .filter(function (line) { return line.length >= 10; })
    .slice(0, 5);

  return lines.map(function (line) {
    const category = detectCategories(line, '')[0];
    const chosen = pickBestProfileForCategories(profiles, [category], null) || profiles[0];
    return {
      title: line.slice(0, 90),
      description: 'Gerada a partir do PDF de pendencias importado no painel do gestor.',
      category: category,
      priority: 'media',
      assignedToUserId: chosen ? chosen.empId : null,
      assignedToName: chosen ? chosen.name : 'Sem responsavel',
      reason: chosen
        ? 'Sugestao heuristica baseada no perfil de ' + chosen.categoryLabel.toLowerCase() + '.'
        : 'Sugestao heuristica sem ranking disponivel.',
      payload: {
        assignedBy: 'Assistente IA',
        status: 'todo'
      }
    };
  }).filter(function (item) { return item.assignedToUserId; });
}

function flattenProfiles(groups) {
  const list = [];
  (groups || []).forEach(function (employee) {
    (employee.profiles || []).forEach(function (profile) {
      list.push({
        empId: employee.empId,
        name: employee.name,
        category: profile.category,
        categoryLabel: profile.categoryLabel,
        score: profile.score,
        confidence: profile.confidence,
        doneCount: profile.doneCount,
        openCount: profile.openCount,
        doingCount: profile.doingCount,
        avgDoneMs: profile.avgDoneMs
      });
    });
  });
  return list;
}

function pickBestProfileForCategories(profiles, categories, excludeEmpId) {
  const allowed = (profiles || []).filter(function (profile) {
    return categories.indexOf(profile.category) !== -1 && Number(profile.empId) !== Number(excludeEmpId);
  });
  if (!allowed.length) return null;
  return allowed.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.confidence - a.confidence;
  })[0];
}

function findProfileByUserAndCategory(profiles, empId, category) {
  return (profiles || []).filter(function (profile) {
    return Number(profile.empId) === Number(empId) && profile.category === category;
  }).sort(function (a, b) { return b.score - a.score; })[0] || null;
}

function detectCategories(title, description) {
  const text = (cleanText(title) + ' ' + cleanText(description)).toLowerCase();
  const matches = CATEGORY_DEFS.filter(function (category) {
    return category.keywords.some(function (keyword) { return text.indexOf(keyword) !== -1; });
  }).map(function (category) { return category.key; });
  return matches.length ? matches.slice(0, 2) : ['administrativo'];
}

function getCategoryDef(categoryKey) {
  return CATEGORY_DEFS.filter(function (item) { return item.key === categoryKey; })[0]
    || { key: categoryKey, label: categoryKey };
}

function scoreKeywordHits(categoryKey, title, description) {
  const category = getCategoryDef(categoryKey);
  const text = (cleanText(title) + ' ' + cleanText(description)).toLowerCase();
  return category.keywords.reduce(function (sum, keyword) {
    return sum + (text.indexOf(keyword) !== -1 ? 1 : 0);
  }, 0);
}

function normalizeCategory(value) {
  const normalized = cleanText(value).toLowerCase();
  return getCategoryDef(normalized).key;
}

function cleanPriority(value) {
  const normalized = cleanText(value).toLowerCase();
  return ['baixa', 'media', 'alta', 'critica'].indexOf(normalized) !== -1 ? normalized : 'media';
}

function cleanPeriod(value) {
  return ['today', '7d', '30d', 'history'].indexOf(value) !== -1 ? value : DEFAULT_REPORT_PERIOD;
}

function cleanText(value) {
  return String(value || '').trim();
}

function cleanBase64(value) {
  const text = cleanText(value);
  if (!text) return '';
  const match = text.match(/^data:.*;base64,(.+)$/);
  return match ? match[1] : text;
}

function cleanStringArray(value) {
  return Array.isArray(value)
    ? value.map(function (item) { return cleanText(item); }).filter(Boolean)
    : [];
}

function normalizePendingDocument(row) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size || 0),
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    storageStatus: row.storage_status,
    status: row.status,
    createdByUserId: row.created_by_user_id == null ? null : Number(row.created_by_user_id),
    extractedText: row.extracted_text || '',
    extractedPreview: String(row.extracted_text || '').slice(0, 1200),
    analysis: typeof row.analysis_json === 'string' ? JSON.parse(row.analysis_json) : row.analysis_json,
    createdAt: row.created_at,
    analyzedAt: row.analyzed_at,
    appliedAt: row.applied_at,
    suggestions: []
  };
}

function findMetricName(context, empId) {
  const metric = (context.employeeMetrics || []).filter(function (item) {
    return Number(item.empId) === Number(empId);
  })[0];
  return metric ? metric.name : 'Colaborador';
}

function mergeUnique(base, extra) {
  const seen = {};
  return (base || []).concat(extra || []).filter(function (item) {
    const key = cleanText(item);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function clampScore(value) {
  const num = Number(value || 0);
  if (num < 1) return 1;
  if (num > 100) return 100;
  return Math.round(num);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function createDocumentId() {
  return 'pdf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function persistAiRunDirect(input) {
  return query(
    `
      INSERT INTO ai_runs (kind, created_by_user_id, input_json, output_json, status)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
    `,
    [
      input.kind,
      input.createdByUserId,
      JSON.stringify(input.inputJson || {}),
      JSON.stringify(input.outputJson || {}),
      input.status || 'completed'
    ]
  );
}

async function persistAiRun(client, input) {
  return client.query(
    `
      INSERT INTO ai_runs (kind, created_by_user_id, input_json, output_json, status)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
    `,
    [
      input.kind,
      input.createdByUserId,
      JSON.stringify(input.inputJson || {}),
      JSON.stringify(input.outputJson || {}),
      input.status || 'completed'
    ]
  );
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = {
  analyzePendingDocument,
  createPendingDocument,
  getLatestOperationalReport,
  getPendingDocument,
  listPendingDocuments,
  listPerformanceProfiles,
  refreshOperationalIntelligence
};
