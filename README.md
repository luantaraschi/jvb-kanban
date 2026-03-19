# JVB Kanban

Sistema de produtividade para equipe juridica, com board Kanban, painel do gestor, historico diario e autenticacao por JWT.

## Stack atual

- Frontend estatico em `public/index.html` + `public/app.js`
- Backend Express reutilizavel para local e Netlify Functions
- Banco `Postgres` no `Supabase`
- Deploy alvo: `Netlify`

## O que mudou

- `SQLite` local foi removido
- o bootstrap de usuarios demo fixos foi removido
- o primeiro gestor e criado via variaveis de ambiente
- o gestor agora pode:
  - criar usuario
  - editar nome/login/perfil
  - ativar ou desativar usuario
  - redefinir senha
- o gestor consegue criar tarefa para o funcionario atualmente selecionado no board
- todos os membros autenticados agora colaboram no board inteiro
- as tarefas guardam criador e ultimo editor
- o painel do gestor agora tem um workspace de IA para feedback, distribuicao e triagem de iniciais
- a IA operacional agora gera snapshots automaticos, perfis por especialidade e intake de PDF com historico

## Variaveis de ambiente

Copie `.env.example` para `.env` e preencha:

```env
DATABASE_URL=postgresql://...
JWT_SECRET=...
ADMIN_NAME=Gestor
ADMIN_USERNAME=gestor
ADMIN_PASSWORD=senha_forte
AI_ENABLED=true
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
AI_TIMEOUT_MS=45000
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=ai-pending-documents
AI_REFRESH_SECRET=...
PORT=3000
NODE_ENV=development
```

## Setup do banco

1. Crie um projeto no Supabase.
2. Pegue a `DATABASE_URL` do pooler.
3. Configure as variaveis acima.
4. Rode:

```bash
npm install
npm run setup:db
```

O script cria/verifica o schema e garante que exista um gestor ativo inicial.

O schema de referencia tambem esta em `db/schema.sql`.

## Rodando localmente

```bash
npm install
npm run dev
```

Abra `http://localhost:3000`.

## Deploy na Netlify

Este repo ja vem com `netlify.toml`.

Passos:

1. Suba o projeto para um repositorio Git.
2. Crie um site na Netlify a partir desse repo.
3. Configure as variaveis de ambiente:
   - `DATABASE_URL`
   - `JWT_SECRET`
   - `ADMIN_NAME`
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `AI_ENABLED`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL`
   - `AI_TIMEOUT_MS`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_STORAGE_BUCKET`
   - `AI_REFRESH_SECRET`
   - `NODE_ENV=production`
4. Faça o deploy.

Rotas:

- frontend publicado a partir de `public/`
- `/api/*` reescrito para `netlify/functions/api.js`
- SPA fallback para `index.html`

## Endpoints principais

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `GET /api/tasks`
- `POST /api/tasks`
- `PUT /api/tasks/:id`
- `PATCH /api/tasks/:id/status`
- `DELETE /api/tasks/:id`
- `GET /api/team`
- `GET /api/history`
- `POST /api/history/close-day`
- `GET /api/manager/users`
- `POST /api/manager/users`
- `PUT /api/manager/users/:id`
- `PATCH /api/manager/users/:id/status`
- `PUT /api/manager/users/:id/password`
- `POST /api/manager/ai/chat`
- `POST /api/manager/ai/feedback`
- `POST /api/manager/ai/task-assignment`
- `GET /api/manager/ai/reports/latest`
- `POST /api/manager/ai/reports/refresh`
- `GET /api/manager/ai/performance-profiles`
- `POST /api/manager/ai/initial-triage`
- `POST /api/manager/ai/initial-triage/:runId/create-tasks`
- `GET /api/manager/ai/pending-documents`
- `POST /api/manager/ai/pending-documents`
- `GET /api/manager/ai/pending-documents/:id`
- `POST /api/manager/ai/pending-documents/:id/analyze`
- `POST /api/manager/ai/pending-documents/:id/apply-assignments`

## Automacao recorrente

- `netlify/functions/ai-refresh.js` agenda o refresh da inteligencia operacional a cada `30` minutos
- `netlify/functions/ai-refresh-background.js` executa o processamento pesado em background
- os snapshots persistidos alimentam o centro de inteligencia operacional no painel do gestor
