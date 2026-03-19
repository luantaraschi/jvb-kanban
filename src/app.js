'use strict';

require('dotenv').config();

const cookieParser = require('cookie-parser');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { initDb } = require('./db');
const routes = require('./routes');

function createApp() {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'fonts.gstatic.com'],
        fontSrc: ["'self'", 'fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:']
      }
    }
  }));

  app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? false : 'http://localhost:3000',
    credentials: true
  }));

  app.use(express.json());
  app.use(cookieParser());

  app.use(async (req, res, next) => {
    try {
      await initDb();
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(path.join(__dirname, '../public')));
  app.use('/api', routes);

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Erro interno do servidor' });
  });

  return app;
}

module.exports = { createApp };
