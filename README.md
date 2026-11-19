# MAKEEN FM Portal — API

NestJS 11 API for the Facility Management Portal. This folder is **fully self-contained**, with nothing outside it needed: it has its own dependencies, env, domain contract (`src/shared/`), Docker image and dev containers. Move it anywhere and it runs the same. It's deployed to its own server, and the web app reaches it through its `/api/*` proxy.

## Local setup

```bash
npm ci                    # also generates the Prisma client
npm run keys:generate     # creates .env and fills every secret

# Database — EITHER a local PostgreSQL 17+ (e.g. the Windows service):
npm run db:bootstrap      # asks for the postgres superuser password once; creates roles
                          # makeen_owner / makeen_app and databases makeen / makeen_test,
                          # writes DATABASE_URL, MIGRATE_DATABASE_URL, TEST_DATABASE_URL
# OR Docker (also gives Redis, Mailpit, S3):
npm run infra:up

npm run db:migrate        # apply prisma/migrations (schema owner)
npm run db:seed           # demo world that recreates the mockup (SEED_TODAY, default 16-10-2026)
npm run start:dev         # http://localhost:4000
```

`npm run db:reset` rebuilds the dev database from scratch (drop → migrate → seed).

### Demo logins (local development only)

Every ACTIVE demo person signs in with `SEED_DEFAULT_PASSWORD` from your `api/.env`.

**Sign-in needs Redis** (Docker `npm run infra:up`, or Memurai on Windows). Without Redis, login and OTP sending answer 503 on purpose: brute-force limits fail closed (D-62). With `EMAIL_PROVIDER=console` / `SMS_PROVIDER=console`, change-password OTPs are written to the API log instead of being sent.

Auth endpoints (all under `/api`):
- `GET auth/csrf`, `POST auth/login`, `auth/refresh`, `auth/logout`
- `POST auth/password/options`, `auth/password/otp`, `auth/password`
- `GET me`

Every POST needs the `X-CSRF-Token` header that matches the `mk_csrf` cookie.

People endpoints (Admin; module PEOPLE):
- `GET people` (filters `plantId, roleId, loginStatus, workingStatus, q`, paging, the four cards), `GET people/logins`, `GET people/:id`
- `PUT people/:id/assignment`, `POST people/:id/activate`, `POST people/:id/deactivate`, `POST people/:id/reset-password`
- `POST people/import` (multipart `file` + `dryRun`; CSV or .xlsx), `POST people/import/keka-api`, `GET people/import/status`
- `GET roles`, `GET roles/:id`, `PUT roles/:id`, `POST roles/:id/reset`, `POST roles`
- `GET designations`, `PUT designations`

Daily MIS endpoints (module DAILY_MIS):
- `GET daily-mis` (filters `plantId, from, to, status`, paging; cards and totals), `GET daily-mis/queue`, `GET daily-mis/export?format=xlsx|pdf` (same filter)
- `POST daily-mis`, `GET daily-mis/:id`, `PUT daily-mis/:id` (`action: draft|submit`, `version`), `GET daily-mis/:id/revisions/:version`, `GET daily-mis/:id/pdf`
- `POST daily-mis/:id/approve`, `POST daily-mis/:id/return` (reason), `POST daily-mis/:id/reopen` (reason)
- `GET monthly-mis` (filters `plantId, month, status`; one month, default the previous IST month; cards and totals), `GET monthly-mis/queue`, `GET monthly-mis/summary?plantId&month` (live Section A), `GET monthly-mis/export?format=xlsx|pdf` (same filter)
- `POST monthly-mis`, `GET monthly-mis/:id`, `PUT monthly-mis/:id` (`action`, `version`, `values`, `cylinders`, `inventory`), `GET monthly-mis/:id/pdf`
- `POST monthly-mis/:id/approve` (freezes Section A), `POST monthly-mis/:id/return` (reason), `POST monthly-mis/:id/reopen` (reason; Section A live again)
- `GET daily-exceptions` (filters `plantId, from, to, status` incl. `NOT_INITIATED`; every plant-day, cards, Lapse), `GET daily-exceptions/export?format=xlsx|pdf`, `PUT daily-exceptions/lapse-notes` (note for a missed day)
- `POST daily-exceptions`, `GET daily-exceptions/:id`, `PUT daily-exceptions/:id` (`action: draft|submit`, `version`, `plantStatus`, `lines`), `GET daily-exceptions/:id/pdf`
- `POST daily-exceptions/:id/files` (multipart `file`: PDF/JPG/PNG/XLSX ≤ 10 MB), `GET daily-exceptions/:id/files/:fileId` (download), `DELETE daily-exceptions/:id/files/:fileId`
- Files are stored by `STORAGE_DRIVER`: `s3` (SeaweedFS / bucket) or `local` (dev only, `STORAGE_LOCAL_DIR`)
- `GET plants` (filters `q, status`; CARD-8), `GET plants/export`, `GET plants/people-options` (Admin), `POST plants` / `PUT plants/:id` (Admin), `POST plants/:id/delete` (`DELETE_PLANT`, reason), `GET plants/:id`
- `PUT plants/:id/details`, `POST|DELETE plants/:id/activities[/:activityId]`, `POST|GET|DELETE plants/:id/activities/:activityId/images[/:fileId]` (JPG/PNG), `POST|GET|DELETE plants/:id/files[/:fileId]` (contract)
- `GET audits` (filters `plantId, auditType, fy, status`; CARD-6), `GET audits/export`, `POST audits`, `GET|PUT audits/:id` (header + observation rows, `version`), `POST|GET|DELETE audits/:id/files[/:fileId]`
- `GET licences?category=STATUTORY|INTERNAL` (filters `plantId, licenceType, status`; CARD-7), `GET licences/export`, `GET licences/items`, `GET licences/remind-options?plantId`, `POST licences`, `GET|PUT licences/:id`, `POST|GET|DELETE licences/:id/files[/:fileId]`
- `GET review-check` (filters `plantId, status`), `GET review-check/export`
- `GET notifications` (`filter=ALL|UNREAD|TO_ACKNOWLEDGE|REPLIES|CUSTOM`, `q`; cards), `GET notifications/unread-count`, `GET notifications/stream` (SSE, event `unread`), `GET notifications/people`, `POST notifications/notes`, `POST notifications/read-all`, `GET notifications/:id`, `POST notifications/:id/read|acknowledge|reply`
- `GET notification-control/events`, `PUT notification-control/events/:event`, `GET notification-control/log`, `POST notification-control/custom/preview`, `POST notification-control/custom`, `POST notification-control/run-daily` (Admin; idempotent)
- Scheduled work in-process (`JOBS_ENABLED`, `NOTICE_DAILY_AT=07:00` IST): daily Licence Due/Expired + Audit overdue notices, email outbox every 15 s

The KEKA loader contract and the KEKA API settings are in the repository's `docs/DEPLOYMENT.md` (section "Loading people from KEKA").

| Email | Role | Plants |
|---|---|---|
| anita.sharma@makeenenergy.com | Admin | all 22 |
| ravi.kumar@makeenenergy.com | Plant Manager | HPCL Yediyur |
| asha.nair@makeenenergy.com | Maintenance Officer | HPCL Yediyur, HPCL Barhi |
| rahul.verma@makeenenergy.com | Safety Officer | IOCL Gwalior |
| deepak.sahu@makeenenergy.com | Sr. Operations and Maintenance Officer | IOCL Korba |
| meera.iyer@makeenenergy.com | Zonal Manager | 8 South plants |
| rajesh.menon@makeenenergy.com | QHSE Head | all 22 |
| gopal.das@makeenenergy.com | Staff | HPCL Barhi |
| manoj.singh@makeenenergy.com | Operation Officer — **inactive, resigned** | HPCL Barhi |
| sanjay.ghosh@makeenenergy.com | **unmapped designation** (cannot sign in) | — |

| URL                              | What                                            |
| -------------------------------- | ----------------------------------------------- |
| http://localhost:4000/api/health | Liveness                                        |
| http://localhost:4000/api/ready  | Readiness (DB + Redis; 503 when either is down) |
| http://localhost:4000/api/docs   | Swagger (dev only, `SWAGGER_ENABLED=true`)      |
| http://localhost:8025            | Mailpit dev inbox                               |

`src/shared/` is the domain contract (field definitions, rules, IST time, India formatting). In this repository, `web/src/shared/` is an identical copy: change both together, and CI checks they match.

## Scripts

| Script                                | Does                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| `start:dev` / `build` / `start:prod`  | Nest CLI watch, compile to `dist/`, run compiled build              |
| `lint` / `typecheck` / `format:check` | ESLint (strict type-checked + security) / `tsc --noEmit` / Prettier |
| `test`                                | Unit + in-process HTTP tests (Jest; Postgres/Redis faked)           |
| `test:e2e`                            | End-to-end against real Postgres + Redis — rebuilds `TEST_DATABASE_URL` (must end in `_test`) |
| `keys:generate`                       | Fill `__GENERATE__` values in `.env` (never overwrites real values) |
| `db:bootstrap` / `db:migrate` / `db:seed` / `db:reset` | Create roles + DBs (local Postgres) / apply migrations / load demo data / rebuild |
| `db:generate` / `db:drift`            | Regenerate the Prisma client / show schema ↔ database drift (should be empty) |
| `infra:up` / `infra:down`             | Start/stop the local dependency containers                          |

## Docker

```bash
# from this folder
docker build -t makeen-api .                                  # runtime
docker build --target migrate -t makeen-api-migrate .         # one-off migration job
docker run --env-file .env makeen-api-migrate                 # run BEFORE starting a new version
docker run --env-file .env -p 4000:4000 makeen-api
```

## Layout

```
src/
  main.ts            bootstrap + graceful shutdown
  app.setup.ts       helmet, CORS, cookies, body limits, Swagger (dev), prefix /api
  config/            Zod env schema (fail fast)
  common/            errors, filters, pipes (nestjs-zod), logging, request id
  infra/             pg pool, Redis client
  prisma/            PrismaService (runAs → RLS context), DB role boot check
  generated/prisma/  generated Prisma client (git-ignored)
  modules/           feature modules (health now; auth, users, … in later phases)
  shared/            domain contract (identical copy in web/src/shared)
prisma/
  schema.prisma      every table, enum, index (incl. partial unique)
  migrations/        init (generated) + security (RLS, CHECKs, audit-log triggers, grants)
  seed/              deterministic demo world (mockup data)
prisma.config.ts     Prisma 7 config (MIGRATE_DATABASE_URL)
test/                e2e specs (*.e2e-spec.ts), e2e global setup, unit-test env setup
scripts/             generate-keys.mjs, db-bootstrap.mjs
docker-compose.yml   dev containers: postgres, redis, mailpit, seaweedfs
```
