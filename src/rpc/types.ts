/**
 * Type definitions for the JSON-RPC stdin control channel.
 *
 * Incoming requests arrive as NDJSON lines on stdin (one per line).
 * Outgoing acknowledgments are NDJSON events emitted to stdout.
 */

export interface SteerRequest {
	method: "steer";
	params: { content: string };
}

export interface FollowUpRequest {
	method: "followUp";
	params: { content: string };
}

export interface AbortRequest {
	method: "abort";
}

export interface GetStateRequest {
	id: number | string;
	method: "getState";
}

export type RpcRequest = SteerRequest | FollowUpRequest | AbortRequest | GetStateRequest;

export type RpcAckStatus = "queued" | "accepted" | "rejected";

export type AgentStatus = "idle" | "working" | "error";

/**
 * Compact view of a tracked commitment surfaced through getState.
 * `status` distinguishes still-outstanding promises (`pending`) from those
 * the pipeline has detected as fulfilled (`resolved`).
 */
export interface PipelineCommitmentSnapshot {
	id: string;
	turn: number;
	text: string;
	status: "pending" | "resolved";
}

/** Pipeline state snapshot included in getState responses when using v1 pipeline. */
export interface PipelineRpcState {
	activeOperationId: number | null;
	operationCount: number;
	contextUtilization: number;
	archiveEntryCount: number;
	/**
	 * Tracked commitments (pending + resolved), most-recent first, capped at
	 * `MAX_RPC_COMMITMENTS` (50). Empty when no commitments have been observed.
	 */
	commitments: PipelineCommitmentSnapshot[];
}

/** Cap on commitments surfaced through getState to bound payload size. */
export const MAX_RPC_COMMITMENTS = 50;

export interface AgentStateSnapshot {
	status: AgentStatus;
	currentTool?: string;
	/** Present when the v1 context pipeline is active. */
	pipeline?: PipelineRpcState;
}
