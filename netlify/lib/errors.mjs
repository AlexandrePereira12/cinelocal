export class HttpError extends Error {
  // `details` (opcional) vai junto no corpo da resposta de erro, ao lado de `error` e `code` (ex.: o título achado no 409).
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
