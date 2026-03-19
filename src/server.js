'use strict';

require('dotenv').config();

const { createApp } = require('./app');
const { initDb } = require('./db');

const PORT = process.env.PORT || 3000;

async function start() {
  await initDb();
  const app = createApp();

  app.listen(PORT, () => {
    console.log(`JVB Kanban rodando em http://localhost:${PORT}`);
    console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch((error) => {
  console.error('Falha ao iniciar a aplicacao:', error);
  process.exit(1);
});
