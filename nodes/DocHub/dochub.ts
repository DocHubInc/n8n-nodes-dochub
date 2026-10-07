import { createHmac, timingSafeEqual } from 'node:crypto';

export const DOCHUB_API_BASE_URL = 'https://dochub.com/api/v2';

export const DOCHUB_PING_EVENT = 'webhook.ping';

export const DOCHUB_SIGNATURE_PREFIX = 'dochub_v1=';

/** Reject deliveries whose timestamp is further than this from now, in either direction. */
export const DOCHUB_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export const DOCHUB_EVENTS = [
	{
		name: 'Document Created',
		value: 'document.created',
		description: 'Fires when a document is created',
	},
	{
		name: 'Document Shared',
		value: 'document.shared',
		description: 'Fires when a document is shared',
	},
	{
		name: 'Document Status Changed',
		value: 'document.status_changed',
		description: 'Fires when a sign request reaches a terminal state',
	},
	{
		name: 'Sign Request Created',
		value: 'sign_request.created',
		description: 'Fires when a sign request is created',
	},
	{
		name: 'Sign Request Voided',
		value: 'sign_request.voided',
		description: 'Fires when an in-progress sign request is canceled',
	},
	{
		name: 'Signer Finalized',
		value: 'signer.finalized',
		description: 'Fires when a signer finishes signing',
	},
	{
		name: 'Signer Rejected',
		value: 'signer.rejected',
		description: 'Fires when a signer rejects a sign request',
	},
] as const;

export const DOCHUB_EVENT_VALUES: string[] = DOCHUB_EVENTS.map((event) => event.value);

const DOCHUB_EVENT_VALUE_SET = new Set<string>(DOCHUB_EVENT_VALUES);

export type DocHubWebhook = {
	id: string;
	url: string;
	events: string[];
	secret?: string;
	enabled?: boolean;
};

export type SignatureCheck =
	| { valid: true }
	| {
			valid: false;
	  };

export function readEvents(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((event): event is string => typeof event === 'string' && event.length > 0);
}

export function assertKnownEvents(events: string[]): void {
	if (events.length === 0) {
		throw new Error('Select at least one DocHub event');
	}

	const unknown = events.filter((event) => !DOCHUB_EVENT_VALUE_SET.has(event));
	if (unknown.length > 0) {
		throw new Error(`Unknown DocHub event: ${unknown.join(', ')}`);
	}
}

export function sameStringSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function singleHeader(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value;
	if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
	return undefined;
}

export function verifyDocHubSignature(input: {
	secret: string;
	timestamp: string | undefined;
	signature: string | undefined;
	rawBody: Buffer;
	nowSeconds?: number;
}): SignatureCheck {
	const { secret, timestamp, signature, rawBody } = input;
	if (!timestamp || !/^\d+$/.test(timestamp) || !signature) {
		return { valid: false };
	}

	const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	const timestampSeconds = Number(timestamp);
	if (Math.abs(nowSeconds - timestampSeconds) > DOCHUB_TIMESTAMP_SKEW_SECONDS) {
		return { valid: false };
	}

	const digest = createHmac('sha256', secret)
		.update(timestamp, 'utf8')
		.update('.', 'utf8')
		.update(rawBody)
		.digest('hex');
	const expected = `${DOCHUB_SIGNATURE_PREFIX}${digest}`;
	const actualBuffer = Buffer.from(signature, 'utf8');
	const expectedBuffer = Buffer.from(expected, 'utf8');

	if (
		actualBuffer.length !== expectedBuffer.length ||
		!timingSafeEqual(actualBuffer, expectedBuffer)
	) {
		return { valid: false };
	}

	return { valid: true };
}

export function assertPublicHttpsUrl(url: string): void {
	const parsed = tryParseUrl(url);
	if (!parsed) {
		throw new Error('n8n produced a webhook URL that is not valid');
	}
	if (parsed.protocol !== 'https:') {
		throw new Error(
			'DocHub only accepts HTTPS webhook URLs. For local testing, open a public tunnel and set WEBHOOK_URL to that HTTPS address before activating the workflow.',
		);
	}

	const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		isPrivateHostname(host)
	) {
		throw new Error(
			'DocHub rejects private webhook URLs such as localhost. For local testing, open a public tunnel and set WEBHOOK_URL to that HTTPS address before activating the workflow.',
		);
	}
}

export function parseWebhook(payload: unknown): DocHubWebhook {
	const record = asRecord(payload);
	if (!record) {
		throw new Error('DocHub returned a webhook response that was not an object');
	}

	const data = asRecord(record.data);
	const source = data ?? record;
	const attributes = asRecord(source.attributes) ?? source;
	const id = readString(source.id) ?? readString(attributes.id);
	const url = readString(attributes.url);
	const events = readStringArray(attributes.events);
	const secret = readString(attributes.secret);
	const enabled = typeof attributes.enabled === 'boolean' ? attributes.enabled : undefined;

	if (!id || !url || !events) {
		throw new Error('DocHub returned a webhook response without an id, url, or events list');
	}

	return { id, url, events, secret, enabled };
}

export function parsePdfUrl(payload: unknown): { url: string; expiresIn?: number } {
	const record = asRecord(payload);
	const url = record ? readString(record.url) : undefined;
	if (!record || !url) {
		throw new Error('DocHub did not return a PDF download URL');
	}

	const parsed = tryParseUrl(url);
	if (!parsed) {
		throw new Error('DocHub returned a PDF download URL that is not valid');
	}

	if (parsed.protocol !== 'https:') {
		throw new Error('DocHub returned a PDF download URL that is not HTTPS');
	}

	const expiresIn = typeof record.expiresIn === 'number' ? record.expiresIn : undefined;
	return { url, expiresIn };
}

export function safePdfFileName(header: unknown, documentId: string): string {
	const fallback = `${sanitizeFileStem(documentId) || 'document'}.pdf`;
	const raw = singleHeader(header);
	if (!raw) return fallback;

	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(raw);
	const quoted = /filename="([^"]+)"/i.exec(raw);
	const plain = /filename=([^;]+)/i.exec(raw);
	const candidate = encoded?.[1]
		? decodeURIComponentSafe(encoded[1])
		: (quoted?.[1] ?? plain?.[1])?.trim();
	if (!candidate) return fallback;

	const base = candidate.split(/[/\\]/).pop()?.trim();
	const cleaned = sanitizeFileStem(base ?? '');
	if (!cleaned) return fallback;
	return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

function tryParseUrl(url: string): URL | undefined {
	try {
		return new URL(url);
	} catch {
		return undefined;
	}
}

function isPrivateHostname(host: string): boolean {
	if (host === '0.0.0.0' || host === '::1' || host === '::') return true;

	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!match) return false;

	const octets = match.slice(1).map((octet) => Number(octet));
	if (octets.some((octet) => octet > 255)) return true;

	const [first, second] = octets;
	if (first === 10 || first === 127 || first === 0) return true;
	if (first === 169 && second === 254) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	if (first === 192 && second === 168) return true;
	return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
	return value as string[];
}

function sanitizeFileStem(value: string): string {
	return value
		.replace(/[^A-Za-z0-9._ ()-]+/g, '_')
		.replace(/^\.+/g, '')
		.slice(0, 180);
}

function decodeURIComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
