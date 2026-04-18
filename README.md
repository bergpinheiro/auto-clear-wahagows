# auto-clear-wahagows

Serviço **Node.js** em **Docker** que remove periodicamente linhas antigas da tabela `gows_messages` em cada banco de sessão do GOWS no PostgreSQL, alinhado ao comportamento da WAHA Plus (`PsqlStore`, limpeza de mensagens GOWS).

## Requisitos

- Node.js 20+ (desenvolvimento local) ou apenas Docker
- Mesma `WHATSAPP_SESSIONS_POSTGRESQL_URL` e o mesmo critério de nome de banco que a WAHA (este job só é útil com **GOWS** e `gows_messages`).

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `WHATSAPP_SESSIONS_POSTGRESQL_URL` | Sim | URL PostgreSQL (mesma da WAHA). A senha não é logada. |
| `WHATSAPP_DEFAULT_ENGINE` | Recomendado | Ex.: `GOWS` → segmento `gows` no nome do banco (`waha_gows_<sessão>`). É a forma principal de alinhar com a WAHA em modo GOWS. |
| `WAHA_SESSION_NAMESPACE` | Não | Só se precisar de paridade com uma WAHA que define namespace explícito; caso contrário use `WHATSAPP_DEFAULT_ENGINE`. Resolução neste serviço: `WHATSAPP_DEFAULT_ENGINE` → `WAHA_SESSION_NAMESPACE` → `WEBJS`. |
| `SESSION_NAMES` | Condicional | Lista separada por vírgulas. Obrigatória **só** em modo só-env (`WAHA_BASE_URL` ausente ou `WAHA_USE_SESSION_API=false`). Com API ativa, falha ou lista vazia na WAHA → o job termina sem limpar (sem erro), sem usar `SESSION_NAMES` como fallback. |
| `IGNORE_SESSION_NAMES` | Não | Lista separada por vírgulas: sessões que **nunca** entram na limpeza (match sem diferenciar maiúsculas/minúsculas). Vale para API e para `SESSION_NAMES`. Alias: `SESSION_NAMES_IGNORE`. |
| `RETENTION_DAYS` | Não | Padrão `90`. Dias a manter; corte = hoje menos N dias (estilo `setDate` do JS). |
| `WAHA_BASE_URL` | Não | Base URL da WAHA para `GET /api/sessions?all=true`. |
| `WAHA_API_KEY` | Não | Enviado como `X-Api-Key` se definido. |
| `WAHA_USE_SESSION_API` | Não | `false`/`0` força uso só de `SESSION_NAMES`. Padrão: tentar API se `WAHA_BASE_URL` existir. |
| `TZ` | Não | Fuso para o agendador (padrão `UTC`). |
| `CRON` | Não | Expressão de **6 campos** (segundo minuto hora dia mês dia-da-semana). Padrão `0 0 2 * * *` (02:00:00 diário). |
| `RUN_ON_START` | Não | `true` executa um job logo ao subir, depois segue o `CRON`. |
| `RUN_ONCE` | Não | `true` executa um único job e encerra (sem agendador). |
| `DRY_RUN` | Não | `true` só faz `COUNT(*)` compatível, sem `DELETE`. |
| `LOG_LEVEL` | Não | `debug`, `info`, `warn`, `error` (padrão `info`). |

Com a API da WAHA, cada sessão pode ter `config.gows.cleanup`: se `enabled === false`, a sessão é ignorada; `retentionDays` opcional sobrescreve o global.

## Execução local

```bash
cp .env.example .env
# Editar .env com URL e sessões reais

set WHATSAPP_SESSIONS_POSTGRESQL_URL=postgresql://...
set WHATSAPP_DEFAULT_ENGINE=GOWS
set SESSION_NAMES=default
set RETENTION_DAYS=90
set RUN_ONCE=1
node src/index.js
```

PowerShell:

```powershell
$env:WHATSAPP_SESSIONS_POSTGRESQL_URL="postgresql://..."
$env:WHATSAPP_DEFAULT_ENGINE="GOWS"
$env:SESSION_NAMES="default"
$env:RUN_ONCE="1"
node src/index.js
```

## Docker

Imagem publicada no Docker Hub: **[`weblooks/auto-clear-wahagows`](https://hub.docker.com/r/weblooks/auto-clear-wahagows)**.

Pull e execução (exemplo):

```bash
docker pull weblooks/auto-clear-wahagows:latest

docker run --rm \
  -e WHATSAPP_SESSIONS_POSTGRESQL_URL="postgresql://user:pass@host:5432/postgres" \
  -e WHATSAPP_DEFAULT_ENGINE=GOWS \
  -e SESSION_NAMES=default \
  -e RETENTION_DAYS=90 \
  -e TZ=UTC \
  -e CRON="0 0 2 * * *" \
  -e DRY_RUN=false \
  weblooks/auto-clear-wahagows:latest
```

Build local a partir deste repositório (opcional):

```bash
docker build -t weblooks/auto-clear-wahagows:local .
```

Compose (com `.env` na mesma pasta; usa a imagem `weblooks/auto-clear-wahagows`):

```bash
cp .env.example .env
# Preencher WHATSAPP_SESSIONS_POSTGRESQL_URL e demais

docker compose pull
docker compose up -d
```

Para reconstruir a imagem a partir do código em vez de puxar do Hub: `docker compose up -d --build`.

### Docker Swarm

Ficheiro [`docker-stack.yml`](./docker-stack.yml): rede externa `traefik-public` (overlay já criada noutro stack, p.ex. Traefik).

```bash
# Na máquina manager, com variáveis exportadas (ou ficheiro .env carregado)
export WHATSAPP_SESSIONS_POSTGRESQL_URL="postgresql://..."
# ... demais variáveis conforme .env.example

docker stack deploy -c docker-stack.yml auto-clear-wahagows
```

Remover o stack: `docker stack rm auto-clear-wahagows`.

## Comportamento

1. Resolve lista de sessões (API WAHA ou `SESSION_NAMES`).
2. Para cada sessão: `database = waha_<namespace>_<slug>` com `slug` = nome em minúsculas, caracteres não `[a-z0-9-]` → `_`.
3. Conecta ao banco da sessão; se não existir tabela `public.gows_messages`, regista skip.
4. `DELETE FROM gows_messages WHERE "timestamp" < $cutoff` (ou `COUNT` se `DRY_RUN`).
5. Logs em JSON por evento; encerramento gracioso em `SIGTERM`/`SIGINT` (agendador cancelado).
