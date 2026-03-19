'use strict';

const serverless = require('serverless-http');
const { createApp } = require('../../src/app');

const app = createApp();
const handler = serverless(app);

exports.handler = async function netlifyHandler(event, context) {
  return handler(event, context);
};
