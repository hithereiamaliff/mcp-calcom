/**
 * A problem with what the model asked for (bad time, missing parameter, refused action).
 * Tools turn it into an isError result with the message as-is, so messages should say
 * what to do next.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}
