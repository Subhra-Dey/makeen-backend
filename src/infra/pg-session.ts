/**
 * Every application connection runs with TimeZone=UTC (DECISIONS D-61).
 *
 * Prisma's pg driver adapter sends DateTime parameters as "YYYY-MM-DD HH:MM:SS.mmm" without an
 * offset, so PostgreSQL interprets them in the *session* time zone. A server set to Asia/Kolkata
 * (the Windows installer default here) silently stored every Prisma-written instant 5 h 30 min
 * early. Pinning the session to UTC makes Prisma, raw SQL and now() agree. Business dates and IST
 * display are handled in src/shared/ist — never by the database session time zone.
 */
export const PG_SESSION_OPTIONS = '-c TimeZone=UTC';
