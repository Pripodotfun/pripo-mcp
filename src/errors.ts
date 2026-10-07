import { PripoContractError, PripoConfigurationError } from '@pripo/sdk';

export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}
const policyMessages: Record<number, string> = {
  1: 'Operator policy is absent or expired at the execution block.',
  2: 'Operator policy does not permit closing positions.',
  3: 'Market proof does not match the operator policy allowlist.',
  4: 'Exact transaction notional exceeds the policy limit.',
  5: 'Exact cumulative notional exceeds the policy limit.',
};
export function publicError(error: unknown) {
  if (error instanceof ToolError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof PripoContractError) {
    const name = error.decoded.errorName;
    const args = error.decoded.args ?? [];
    return { code: name === 'PolicyViolation' ? 'POLICY_VIOLATION' : 'CONTRACT_REVERT',
      message: name === 'PolicyViolation' ? policyMessages[Number(args[0])] ?? 'Operator policy rejected the transaction.' : `Contract reverted: ${name}`,
      details: { errorName: name, args } };
  }
  if (error instanceof PripoConfigurationError) return { code: 'DEPLOYMENT_MISMATCH', message: error.message };
  // Provider errors can contain API keys, signed bytes or authenticated URLs.
  return { code: 'RPC_UNAVAILABLE', message: 'The operation failed. Check RPC availability and server configuration; no provider credentials are returned.' };
}
export const json = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
