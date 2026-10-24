/**
 * HTTP-level error used by the HTTP server for auth / configuration failures.
 * Carries a stable machine-readable code alongside the human message.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
