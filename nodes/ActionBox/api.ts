import type {
	IDataObject,
	IExecuteFunctions,
	IWebhookFunctions,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';
import { API_URL } from './protocol';

type Context = IExecuteFunctions | IWebhookFunctions;
export function retryDelay(
	headers: Record<string, unknown>,
	attempt: number,
	now = Date.now(),
): number {
	const value = headers['retry-after'];
	if (typeof value === 'string' || typeof value === 'number') {
		const seconds = Number(value);
		const millis = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(value)) - now;
		if (Number.isFinite(millis)) return Math.max(0, millis);
	}
	return 250 * 2 ** attempt;
}

export async function request(
	ctx: Context,
	method: 'GET' | 'POST',
	path: string,
	body?: IDataObject,
	key?: string,
): Promise<unknown> {
	const options: IHttpRequestOptions = {
		method,
		url: API_URL + path,
		json: true,
		timeout: 10000,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		disableFollowRedirect: true,
		headers: key ? { 'Idempotency-Key': key } : {},
		...(body ? { body } : {}),
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		let status = 0;
		let headers: Record<string, unknown> = {};
		try {
			const response = await ctx.helpers.httpRequestWithAuthentication.call(
				ctx,
				'actionBoxApi',
				options,
			);
			status = response.statusCode;
			headers = response.headers ?? {};
			if (status >= 200 && status < 300) return response.body;
		} catch {
			// Do not serialize helper errors: they may contain Authorization or callback_url.
		}
		const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
		const delay = retryDelay(headers, attempt);
		if (!retryable || attempt === 2 || delay > 5000) {
			throw new NodeApiError(
				ctx.getNode(),
				{ message: 'ActionBox request failed', httpCode: String(status) },
				{
					message: `ActionBox request failed (${status || 'network error'}). Check credentials, limits, or use Get Action to reconcile an uncertain write.`,
					httpCode: String(status),
				},
			);
		}
		await sleep(delay);
	}
	throw new Error('ActionBox request failed');
}
