'use strict';

const { initDb } = require('../../src/db');
const { refreshOperationalIntelligence } = require('../../src/operational-intelligence');

exports.handler = async function aiRefreshBackgroundHandler(event) {
  const secret = process.env.AI_REFRESH_SECRET;
  if (secret) {
    const incoming = event.headers['x-ai-refresh-secret'] || event.headers['X-AI-REFRESH-SECRET'];
    if (incoming !== secret) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Nao autorizado' })
      };
    }
  }

  try {
    await initDb();
    const snapshot = await refreshOperationalIntelligence({
      period: (event.queryStringParameters && event.queryStringParameters.period) || '7d',
      source: 'scheduled_background',
      createdByUserId: null
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, snapshotId: snapshot.id, generatedAt: snapshot.generatedAt })
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      body: JSON.stringify({ error: error.message || 'Falha ao atualizar inteligencia operacional' })
    };
  }
};
