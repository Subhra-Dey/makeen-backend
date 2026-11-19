import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, type ErrorEnvelope, ErrorCode, statusToCode } from '../errors/app-error';
import { genRequestId, requestIdOf } from '../request-id';

const GENERIC_5XX = 'Something went wrong. Please try again.';

/**
 * Maps every thrown value to the `{ code, message, details?, requestId }` envelope.
 * Never leaks stack traces or internal messages for 5xx (SEC-16).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    // Errors raised before the logging middleware (e.g. an unreadable JSON body) still get an id.
    const known = requestIdOf(req);
    const requestId = known === 'unknown' ? genRequestId(req, res) : known;

    const { status, body } = this.toEnvelope(exception, requestId);
    if (status >= 500) {
      this.logger.error({ err: exception, requestId }, 'Unhandled error');
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  }

  private toEnvelope(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ErrorEnvelope } {
    if (exception instanceof AppError) {
      const body: ErrorEnvelope = { code: exception.code, message: exception.message, requestId };
      if (exception.details !== undefined) body.details = exception.details;
      return { status: exception.status, body };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const fromResponse =
        typeof response === 'object' && 'code' in response && 'message' in response
          ? (response as { code: string; message: string; details?: unknown })
          : null;
      if (fromResponse) {
        const body: ErrorEnvelope = {
          code: fromResponse.code,
          message: fromResponse.message,
          requestId,
        };
        if (fromResponse.details !== undefined) body.details = fromResponse.details;
        return { status, body };
      }
      return {
        status,
        body: {
          code: statusToCode(status),
          message: status >= 500 ? GENERIC_5XX : this.httpMessage(status, exception),
          requestId,
        },
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: ErrorCode.INTERNAL_ERROR, message: GENERIC_5XX, requestId },
    };
  }

  private httpMessage(status: number, exception: HttpException): string {
    switch (status) {
      case 404:
        return 'Not found.';
      case 401:
        return 'Please sign in.';
      case 403:
        return 'You do not have access to this.';
      case 413:
        return 'The request is too large.';
      case 429:
        return 'Too many attempts. Please wait and try again.';
      case 400:
        // Framework-level 400s (malformed JSON etc.) carry parser internals — never echo them.
        return 'The request could not be read.';
      default:
        return exception.message;
    }
  }
}
