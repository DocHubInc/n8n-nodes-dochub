import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { DOCHUB_API_BASE_URL } from './dochub';

type DocHubContext = IHookFunctions | IExecuteFunctions;

export async function dochubApiRequest(
	this: DocHubContext,
	method: 'GET' | 'POST' | 'DELETE',
	path: string,
	body?: IDataObject,
): Promise<unknown> {
	const request: IHttpRequestOptions = {
		method,
		url: `${DOCHUB_API_BASE_URL}${path}`,
		headers: {
			Accept: 'application/json',
		},
		json: method !== 'DELETE',
		// Keep the API key on dochub.com if the API responds with a redirect.
		sendCredentialsOnCrossOriginRedirect: false,
		allowedDomains: 'dochub.com',
	};

	if (body !== undefined) {
		request.body = body;
	}

	return await this.helpers.httpRequestWithAuthentication.call(this, 'docHubApi', request);
}

export async function downloadPdf(
	this: IExecuteFunctions,
	url: string,
): Promise<{ buffer: Buffer; contentDisposition: unknown }> {
	const response: unknown = await this.helpers.httpRequest({
		method: 'GET',
		url,
		encoding: 'arraybuffer',
		json: false,
		returnFullResponse: true,
	});

	const full = asRecord(response);
	const payload = full?.body ?? response;
	return {
		buffer: toBuffer(payload),
		contentDisposition: headerValue(full?.headers, 'content-disposition'),
	};
}

export function rethrowDocHubError(node: INode, error: unknown, itemIndex?: number): never {
	if (error instanceof NodeOperationError || error instanceof NodeApiError) {
		throw error;
	}

	const statusCode = getStatusCode(error);
	if (statusCode === 402) {
		throw new NodeOperationError(
			node,
			'DocHub refused this request because the current plan does not include it. Webhook creation requires a paid DocHub plan.',
			{ itemIndex },
		);
	}

	if (statusCode === 403) {
		throw new NodeOperationError(
			node,
			'DocHub rejected the API key. Grant it the permission for this operation, or the all permission. Webhook setup also needs admin access on the account.',
			{ itemIndex },
		);
	}

	throw new NodeApiError(node, publicError(error), { itemIndex });
}

export function getStatusCode(error: unknown): number | undefined {
	const record = asRecord(error);
	if (!record) return undefined;

	const response = asRecord(record.response);
	const candidates = [record.statusCode, record.httpCode, response?.statusCode, response?.status];
	for (const candidate of candidates) {
		if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
		if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
	}

	return undefined;
}

function publicError(error: unknown): JsonObject {
	const record = asRecord(error);
	const message =
		typeof record?.message === 'string' && record.message.length > 0
			? record.message
			: 'DocHub request failed';
	const statusCode = getStatusCode(error);

	// Copy only status and message. Request config on the raw error can contain the API key.
	return {
		message,
		...(statusCode === undefined ? {} : { statusCode }),
	};
}

function toBuffer(payload: unknown): Buffer {
	if (Buffer.isBuffer(payload)) return payload;
	if (payload instanceof ArrayBuffer) return Buffer.from(payload);
	if (payload instanceof Uint8Array) return Buffer.from(payload);
	throw new Error('DocHub download did not return PDF bytes');
}

function headerValue(headers: unknown, name: string): unknown {
	const record = asRecord(headers);
	if (!record) return undefined;
	return record[name] ?? record[name.toLowerCase()];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}
