import { createHmac, timingSafeEqual } from 'crypto';
import type { IDataObject } from 'n8n-workflow';

export const API_URL = 'https://api.actionbox.cloud';
export const MAX_CALLBACK_BYTES = 262144;
export const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
export type Snapshot = { actionId: string; version: number; fingerprint: string; deadline: number };
export type DecisionStatus =
	| 'approved'
	| 'rejected'
	| 'expired'
	| 'cancelled'
	| 'timed_out'
	| 'snapshot_changed'
	| 'invalid_response';

export function object(value: unknown): IDataObject {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid ActionBox response');
	return value as IDataObject;
}

export function actionData(value: unknown): IDataObject {
	const action = object(object(value).data);
	if (
		typeof action.id !== 'string' ||
		!Number.isInteger(action.action_version) ||
		Number(action.action_version) < 1 ||
		typeof action.fingerprint !== 'string' ||
		!FINGERPRINT.test(action.fingerprint) ||
		!['open', 'resolved', 'expired', 'cancelled'].includes(String(action.status))
	)
		throw new Error('Invalid ActionBox response');
	return action;
}

// Deliberately project the API response: callback URLs contain resume credentials.
export function publicAction(action: IDataObject): IDataObject {
	return {
		id: action.id,
		status: action.status,
		title: action.title,
		action_version: action.action_version,
		fingerprint: action.fingerprint,
		resolution_option_id: action.resolution_option_id ?? null,
		response: action.response ?? null,
		outcome: action.outcome ?? null,
		expires_at: action.expires_at ?? null,
	};
}

export function result(
	input: IDataObject,
	snapshot: Snapshot,
	status: DecisionStatus,
	action?: IDataObject,
): IDataObject {
	return {
		input,
		actionbox: {
			action_id: snapshot.actionId,
			approved: status === 'approved',
			decision_status: status,
			action_version: snapshot.version,
			fingerprint: snapshot.fingerprint,
			deadline: snapshot.deadline,
			response: action?.response ?? null,
			current_action: action ? publicAction(action) : null,
		},
	};
}

export function decision(
	action: IDataObject,
	snapshot: Snapshot,
	now = Date.now(),
): DecisionStatus | null {
	if (now >= snapshot.deadline) return 'timed_out';
	if (action.id !== snapshot.actionId) return 'invalid_response';
	if (action.action_version !== snapshot.version || action.fingerprint !== snapshot.fingerprint)
		return 'snapshot_changed';
	if (action.status === 'open') return null;
	if (action.status === 'expired' || action.status === 'cancelled') return action.status;
	if (action.status !== 'resolved') return 'invalid_response';
	if (action.resolution_option_id === 'approve') return 'approved';
	if (action.resolution_option_id === 'reject') return 'rejected';
	return 'invalid_response';
}

export function snapshotFromResult(value: unknown): { input: IDataObject; snapshot: Snapshot } {
	const saved = object(value);
	const a = object(saved.actionbox);
	if (
		typeof a.action_id !== 'string' ||
		!Number.isInteger(a.action_version) ||
		Number(a.action_version) < 1 ||
		typeof a.fingerprint !== 'string' ||
		!FINGERPRINT.test(a.fingerprint) ||
		typeof a.deadline !== 'number' ||
		!Number.isFinite(a.deadline) ||
		a.approved !== false ||
		a.decision_status !== 'timed_out'
	)
		throw new Error('Missing approval state');
	return {
		input: object(saved.input),
		snapshot: {
			actionId: a.action_id,
			version: Number(a.action_version),
			fingerprint: a.fingerprint,
			deadline: a.deadline,
		},
	};
}

export function verifyEvent(
	raw: Buffer,
	timestamp: unknown,
	signature: unknown,
	secret: string,
	now = Date.now(),
): IDataObject {
	if (
		raw.length > MAX_CALLBACK_BYTES ||
		!secret ||
		typeof timestamp !== 'string' ||
		!/^\d{1,12}$/.test(timestamp) ||
		typeof signature !== 'string' ||
		!/^v1=[0-9a-f]{64}$/.test(signature)
	)
		throw new Error('Invalid callback signature');
	if (Math.abs(now / 1000 - Number(timestamp)) > 300) throw new Error('Stale callback');
	const expected = createHmac('sha256', secret)
		.update(timestamp + '.')
		.update(raw)
		.digest();
	if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex')))
		throw new Error('Invalid callback signature');
	const event = object(JSON.parse(raw.toString('utf8')));
	if (
		typeof event.id !== 'string' ||
		!event.id ||
		typeof event.type !== 'string' ||
		typeof object(event.data).action_id !== 'string'
	)
		throw new Error('Invalid callback envelope');
	return event;
}

export function resumeUrl(base: string, nodeId: string): string {
	const url = new URL(base);
	if (url.protocol !== 'https:' || url.username || url.password)
		throw new Error('A public HTTPS n8n webhook URL is required');
	url.pathname = url.pathname.replace(/\/$/, '') + '/' + encodeURIComponent(nodeId);
	return url.toString();
}
