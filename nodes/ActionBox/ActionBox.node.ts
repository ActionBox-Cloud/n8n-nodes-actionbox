import { createHash } from 'crypto';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { request } from './api';
import {
	actionData,
	decision,
	FINGERPRINT,
	MAX_CALLBACK_BYTES,
	object,
	publicAction,
	result,
	resumeUrl,
	snapshotFromResult,
	verifyEvent,
} from './protocol';
import type { Snapshot } from './protocol';

// Do not use n8n's reserved sendAndWait operation ID: it switches URL admission
// to n8n-owned HMAC links. Service callbacks use the execution resume token.
const approval = { show: { operation: ['requestApproval'] } };
const outcome = { show: { operation: ['reportOutcome'] } };
const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [{ name: 'Action', value: 'action' }],
		default: 'action',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'requestApproval',
		options: [
			{
				name: 'Cancel Action',
				value: 'cancel',
				action: 'Cancel an action',
				description: 'Cancel an outstanding Action',
			},
			{
				name: 'Get Action',
				value: 'get',
				action: 'Get an action',
				description: 'Read an Action owned by this Source',
			},
			{
				name: 'Report Outcome',
				value: 'reportOutcome',
				action: 'Report an outcome',
				description: 'Record execution success or failure',
			},
			{
				name: 'Request Approval and Wait',
				value: 'requestApproval',
				action: 'Request approval and wait',
				description: 'Create an approval request and wait for a decision',
			},
		],
	},
	{
		displayName: 'Title',
		name: 'title',
		type: 'string',
		default: '',
		required: true,
		displayOptions: approval,
	},
	{
		displayName: 'Description',
		name: 'description',
		type: 'string',
		default: '',
		typeOptions: { rows: 4 },
		displayOptions: approval,
	},
	{
		displayName: 'Priority',
		name: 'priority',
		type: 'options',
		default: 'normal',
		options: [
			{ name: 'Low', value: 'low' },
			{ name: 'Normal', value: 'normal' },
			{ name: 'High', value: 'high' },
			{ name: 'Urgent', value: 'urgent' },
		],
		displayOptions: approval,
	},
	{
		displayName: 'Reviewer Emails',
		name: 'reviewerEmails',
		type: 'string',
		default: '',
		placeholder: 'reviewer@example.com',
		description: 'Comma-separated reviewer emails. Leave empty for the Source workspace default.',
		displayOptions: approval,
	},
	{
		displayName: 'Approve Label',
		name: 'approveLabel',
		type: 'string',
		default: 'Approve',
		displayOptions: approval,
	},
	{
		displayName: 'Reject Label',
		name: 'rejectLabel',
		type: 'string',
		default: 'Reject',
		displayOptions: approval,
	},
	{
		displayName: 'Timeout (Minutes)',
		name: 'timeoutMinutes',
		type: 'number',
		default: 1440,
		typeOptions: { minValue: 1, maxValue: 43200 },
		displayOptions: approval,
	},
	{
		displayName:
			'One input item per approval. Continue only when actionbox.approved is true. Expiration and timeout never approve.',
		name: 'approvalNotice',
		type: 'notice',
		default: '',
		displayOptions: approval,
	},
	{
		displayName: 'Action ID',
		name: 'actionId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { hide: { operation: ['requestApproval'] } },
	},
	{
		displayName: 'Reason',
		name: 'reason',
		type: 'string',
		default: '',
		displayOptions: { show: { operation: ['cancel'] } },
	},
	{
		displayName: 'Outcome',
		name: 'outcomeStatus',
		type: 'options',
		default: 'success',
		options: [
			{ name: 'Success', value: 'success' },
			{ name: 'Failed', value: 'failed' },
		],
		displayOptions: outcome,
	},
	{
		displayName: 'Action Version',
		name: 'actionVersion',
		type: 'number',
		default: 1,
		typeOptions: { minValue: 1 },
		required: true,
		displayOptions: outcome,
	},
	{
		displayName: 'Fingerprint',
		name: 'fingerprint',
		type: 'string',
		default: '',
		required: true,
		displayOptions: outcome,
	},
];

function textParameter(
	ctx: IExecuteFunctions,
	name: string,
	index: number,
	min: number,
	max: number,
): string {
	const value = String(ctx.getNodeParameter(name, index)).trim();
	if (value.length < min || value.length > max)
		throw new NodeOperationError(ctx.getNode(), `${name} must contain ${min}–${max} characters`, {
			itemIndex: index,
		});
	return value;
}

// n8n restart webhooks belong to a waiting execution, not a registered trigger.
// Approval waiting is deliberately not exposed as an AI tool in this release.
/* eslint-disable @n8n/community-nodes/webhook-lifecycle-complete, @n8n/community-nodes/node-usable-as-tool */
export class ActionBox implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ActionBox',
		name: 'actionBox',
		group: ['output'],
		version: 1,
		description: 'Request human approval and manage Actions in ActionBox',
		defaults: { name: 'ActionBox' },
		icon: { light: 'file:actionbox.svg', dark: 'file:actionbox.dark.svg' },
		subtitle: '={{$parameter["operation"]}}',
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'actionBoxApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				isFullPath: true,
				path: '={{$nodeId}}',
				restartWebhook: true,
			},
		],
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;
		if (operation === 'requestApproval') {
			if (items.length !== 1)
				throw new NodeOperationError(
					this.getNode(),
					'Request Approval and Wait requires exactly one input item',
				);
			const credentials = await this.getCredentials('actionBoxApi');
			if (!credentials.webhookSecret)
				throw new NodeOperationError(
					this.getNode(),
					'Configure the webhook signing secret for this Source',
				);
			const context = this.getContext('node');
			const invocation = String(this.evaluateExpression('{{ $runIndex }}', 0));
			// Retain the original expiry, callback and payload across n8n Retry On Fail.
			if (!context.approval || object(context.approval).invocation !== invocation) {
				const title = textParameter(this, 'title', 0, 1, 200);
				const description = textParameter(this, 'description', 0, 0, 10000);
				const minutes = Number(this.getNodeParameter('timeoutMinutes', 0));
				if (!Number.isFinite(minutes) || minutes < 1 || minutes > 43200)
					throw new NodeOperationError(
						this.getNode(),
						'Timeout must be between 1 and 43200 minutes',
					);
				const reviewers = [
					...new Set(
						String(this.getNodeParameter('reviewerEmails', 0))
							.split(',')
							.map((email) => email.trim())
							.filter(Boolean),
					),
				];
				if (
					reviewers.length > 15 ||
					reviewers.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
				)
					throw new NodeOperationError(this.getNode(), 'Provide up to 15 valid reviewer emails');
				const deadline = Date.now() + minutes * 60000;
				const callback = resumeUrl(
					String(this.evaluateExpression('{{ $execution.resumeUrl }}', 0)),
					this.getNode().id,
				);
				const key =
					'n8n-' +
					createHash('sha256')
						.update(
							JSON.stringify([
								this.getWorkflow().id,
								this.getExecutionId(),
								this.getNode().id,
								invocation,
							]),
						)
						.digest('hex');
				const payload: IDataObject = {
					title,
					description,
					priority: this.getNodeParameter('priority', 0),
					callback_url: callback,
					expires_at: new Date(deadline).toISOString(),
					on_expire: { type: 'return_expired' },
					options: [
						{
							id: 'approve',
							label: textParameter(this, 'approveLabel', 0, 1, 80),
							style: 'primary',
						},
						{
							id: 'reject',
							label: textParameter(this, 'rejectLabel', 0, 1, 80),
							style: 'destructive',
						},
					],
					...(reviewers.length ? { reviewer_emails: reviewers, visibility: 'restricted' } : {}),
				};
				context.approval = { invocation, key, payload, deadline, input: items[0].json };
			}
			const saved = object(context.approval);
			const created = saved.created
				? object(saved.created)
				: actionData(
						await request(this, 'POST', '/v1/actions', object(saved.payload), String(saved.key)),
					);
			saved.created = publicAction(created);
			const snapshot: Snapshot = {
				actionId: String(created.id),
				version: Number(created.action_version),
				fingerprint: String(created.fingerprint),
				deadline: Number(saved.deadline),
			};
			const input = object(saved.input);
			// The engine persists the INPUT on its stack and bypasses execute on timeout.
			// Replacing only our output would let arbitrary upstream approval flags through.
			items[0].json = result(input, snapshot, 'timed_out');
			const state = decision(created, snapshot);
			if (state)
				return [[{ json: result(input, snapshot, state, created), pairedItem: { item: 0 } }]];
			await this.putExecutionToWait(new Date(snapshot.deadline));
			return [[{ json: items[0].json, pairedItem: { item: 0 } }]];
		}
		const output: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const id = encodeURIComponent(textParameter(this, 'actionId', i, 1, 128));
				let value: unknown;
				if (operation === 'get')
					value = publicAction(actionData(await request(this, 'GET', `/v1/source/actions/${id}`)));
				else if (operation === 'cancel')
					value = publicAction(
						actionData(
							await request(this, 'POST', `/v1/actions/${id}/cancel`, {
								reason: textParameter(this, 'reason', i, 0, 500),
							}),
						),
					);
				else if (operation === 'reportOutcome') {
					const version = Number(this.getNodeParameter('actionVersion', i));
					const fingerprint = String(this.getNodeParameter('fingerprint', i));
					const status = String(this.getNodeParameter('outcomeStatus', i));
					if (
						!Number.isInteger(version) ||
						version < 1 ||
						!FINGERPRINT.test(fingerprint) ||
						!['success', 'failed'].includes(status)
					)
						throw new NodeOperationError(
							this.getNode(),
							'Provide the outcome, approved Action version, and fingerprint',
							{ itemIndex: i },
						);
					value = object(
						await request(this, 'POST', `/v1/actions/${id}/outcome`, {
							status,
							action_version: version,
							fingerprint,
						}),
					).data;
				} else throw new NodeOperationError(this.getNode(), 'Unsupported operation');
				output.push({
					json: { input: items[i].json, actionbox: object(value) },
					pairedItem: { item: i },
				});
			} catch (error) {
				if (!this.continueOnFail())
					throw new NodeOperationError(
						this.getNode(),
						error instanceof Error ? error.message : 'ActionBox operation failed',
						{ itemIndex: i },
					);
				output.push({
					json: {
						input: items[i].json,
						actionbox: { approved: false, error: 'ActionBox operation failed' },
					},
					pairedItem: { item: i },
				});
			}
		}
		return [output];
	}

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const respond = (status: number): IWebhookResponseData => {
			this.getResponseObject()
				.status(status)
				.json({ received: status < 400 });
			return { noWebhookResponse: true };
		};
		let event: IDataObject;
		let stored: ReturnType<typeof snapshotFromResult>;
		try {
			const req = this.getRequestObject();
			const raw = req.rawBody;
			if (!Buffer.isBuffer(raw) || raw.length > MAX_CALLBACK_BYTES) return respond(400);
			const credentials = await this.getCredentials('actionBoxApi');
			const headers = this.getHeaderData();
			event = verifyEvent(
				raw,
				headers['x-actionbox-timestamp'],
				headers['x-actionbox-signature'],
				String(credentials.webhookSecret ?? ''),
			);
			stored = snapshotFromResult(this.evaluateExpression('{{ $json }}'));
			if (object(event.data).action_id !== stored.snapshot.actionId) return respond(400);
		} catch {
			return respond(401);
		}
		if (!['action.resolved', 'action.expired', 'action.cancelled'].includes(String(event.type)))
			return respond(200);
		try {
			const action = actionData(
				await request(
					this,
					'GET',
					`/v1/source/actions/${encodeURIComponent(stored.snapshot.actionId)}`,
				),
			);
			const status = decision(action, stored.snapshot);
			if (!status) return respond(200);
			return {
				webhookResponse: { received: true },
				workflowData: [
					[
						{
							json: result(stored.input, stored.snapshot, status, action),
							pairedItem: { item: 0 },
						},
					],
				],
			};
		} catch {
			return respond(503);
		}
	}
}
