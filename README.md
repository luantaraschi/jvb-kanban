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
GEMINI_MODEL=gemini-3-flash-preview
AI_TIMEOUT_MS=45000
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
- `POST /api/manager/ai/initial-triage`
- `POST /api/manager/ai/initial-triage/:runId/create-tasks`
