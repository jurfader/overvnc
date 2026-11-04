import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * Błąd zwracany klientowi. Format odpowiedzi jest zawsze ten sam:
 *   { "error": "<kod_maszynowy>", "message"?: "<opis dla człowieka>", "details"?: ... }
 */
export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = () => new HttpError(404, 'not_found', 'Nie znaleziono.');

/** Waliduje dane wejściowe; przy błędzie rzuca 400 z listą problemów. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const res = schema.safeParse(data ?? {});
  if (!res.success) {
    throw new HttpError(
      400,
      'validation',
      'Nieprawidłowe dane.',
      res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return res.data;
}

export function errorHandler(err: FastifyError | HttpError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) {
    return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
  }
  // błędy samego Fastify (np. niepoprawny JSON, za duże body) mają statusCode < 500
  const status = (err as FastifyError).statusCode;
  if (status && status < 500) {
    return reply.code(status).send({ error: (err as FastifyError).code ?? 'bad_request', message: err.message });
  }
  req.log.error({ err }, 'nieobsłużony błąd');
  return reply.code(500).send({ error: 'internal', message: 'Wewnętrzny błąd serwera.' });
}
