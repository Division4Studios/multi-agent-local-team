export class AwsError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly fault: 'Sender' | 'Receiver';
  public constructor(code: string, message: string, statusCode = 400, fault: 'Sender' | 'Receiver' = 'Sender') {
    super(message);
    this.name = 'AwsError';
    this.code = code;
    this.statusCode = statusCode;
    this.fault = fault;
  }
}
export const invalid = (message: string): AwsError => new AwsError('InvalidParameterValue', message);
export const unsupported = (service: string, operation: string): AwsError =>
  new AwsError('UnsupportedOperation', `${service}.${operation} is unsupported in this local subset`);
