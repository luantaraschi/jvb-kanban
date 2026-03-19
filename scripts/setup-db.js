'use strict';

require('dotenv').config();

const { initDb, query } = require('../src/db');

initDb()
  .then(async () => {
    const result = await query(
      "SELECT COUNT(*)::int AS count FROM users WHERE role = 'manager' AND is_active = TRUE"
    );

    if (result.rows[0].count < 1) {
      throw new Error('Nenhum gestor ativo encontrado apos o bootstrap. Verifique ADMIN_NAME, ADMIN_USERNAME e ADMIN_PASSWORD.');
    }

    console.log('Schema e bootstrap do gestor verificados com sucesso.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Falha ao preparar o banco:', error.message);
    process.exit(1);
  });
