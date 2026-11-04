/** Submission limits, not model context limits. Count UTF-16 units exactly as
 * JavaScript strings do on both sides; never truncate a user's pasted text. */
export const COORDINATOR_MAX_INPUT_CHARS = 32_000;
export const COORDINATOR_LONG_INPUT_CHARS = 8_000;
export const COORDINATOR_INPUT_TOO_LONG_COPY = '喵，这条消息超过 32,000 个字符啦。请把长资料作为附件上传，输入框里写这次要我做什么；先保留这份原文和已选附件。';

/** Only a code-owned error attests which input rule rejected a submission. */
export class CoordinatorInputError extends Error {
  readonly code = 'COORDINATOR_INPUT_INVALID';
  readonly status: number = 400;
  constructor() { super('这条消息还没有内容，请填写要求后再发送。'); }
}
export class CoordinatorInputTooLongError extends Error {
  readonly code = 'COORDINATOR_INPUT_TOO_LONG';
  readonly status = 413;
  readonly maxInputChars = COORDINATOR_MAX_INPUT_CHARS;
  constructor(readonly inputChars: number) { super(COORDINATOR_INPUT_TOO_LONG_COPY); }
}

/** Empty text may still be a legitimate UI draft with selected attachments. */
export function coordinatorInputFeedback(value: string): string | undefined {
  return value.length > COORDINATOR_MAX_INPUT_CHARS ? COORDINATOR_INPUT_TOO_LONG_COPY : undefined;
}
export function coordinatorInputHint(value: string): string | undefined {
  return coordinatorInputFeedback(value) ?? (value.length > COORDINATOR_LONG_INPUT_CHARS
    ? `${value.length.toLocaleString('en-US')} / 32,000 个字符；整份资料也可以作为附件发送。` : undefined);
}
export function assertCoordinatorInput(value: unknown): string {
  if (typeof value !== 'string') throw new CoordinatorInputError();
  // Measure the original before trim; clients and direct API calls must agree.
  if (value.length > COORDINATOR_MAX_INPUT_CHARS) throw new CoordinatorInputTooLongError(value.length);
  if (!value.trim()) throw new CoordinatorInputError();
  return value.trim();
}
