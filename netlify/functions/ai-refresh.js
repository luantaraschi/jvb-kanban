'use strict';

const { initDb } = require('../../src/db');
const { refreshOperationalIntelligence } = require('../../src/operational-intelligence');

exports.config = {
  schedule: '*/30 * * * *'
};

exports.handler = async function aiRefreshScheduledHandler() {
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  const secret = process.env.AI_REFRESH_SECRET || '';

  if (baseUrl) {
    try {
      const response = await fetch(String(baseUrl).replace(/\/$/, '') + '/.netlify/functions/ai-refresh-background?period=7d', {
        method: 'POST',
        headers: secret ? { 'x-ai-refresh-secret': secret } : {}
      });
      const text = await response.text();
      return {
        statusCode: response.ok ? 202 : response.status,
        body: text || JSON.stringify({ ok: response.ok })
      };
    } catch (error) {}
  }

  try {
    await initDb();
    const snapshot = await refreshOperationalIntelligence({
      period: '7d',
      source: 'scheduled_direct',
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
