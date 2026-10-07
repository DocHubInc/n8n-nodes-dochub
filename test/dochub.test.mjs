import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
	DOCHUB_EVENT_VALUES,
	DOCHUB_SIGNATURE_PREFIX,
	assertPublicHttpsUrl,
	parsePdfUrl,
	parseWebhook,
	safePdfFileName,
	verifyDocHubSignature,
} from '../nodes/DocHub/dochub.ts';

const NOW = 1_712_667_600;

function sign(secret, timestamp, rawBody) {
	const digest = createHmac('sha256', secret)
		.update(`${timestamp}.`, 'utf8')
		.update(rawBody)
		.digest('hex');
	return `${DOCHUB_SIGNATURE_PREFIX}${digest}`;
}

describe('DocHub events', () => {
	it('lists every subscribable DocHub event', () => {
		assert.deepEqual(DOCHUB_EVENT_VALUES, [
			'document.created',
			'document.shared',
			'document.status_changed',
			'sign_request.created',
			'sign_request.voided',
			'signer.finalized',
			'signer.rejected',
		]);
	});
});

describe('verifyDocHubSignature', () => {
	const secret = randomBytes(24).toString('hex');
	const timestamp = String(NOW);
	const rawBody = Buffer.from('{"type":"document.status_changed","id":"evt_1"}', 'utf8');

	it('accepts a signature over the raw body', () => {
		const result = verifyDocHubSignature({
			secret,
			timestamp,
			signature: sign(secret, timestamp, rawBody),
			rawBody,
			nowSeconds: NOW,
		});
		assert.equal(result.valid, true);
	});

	it('rejects a body that does not match the signed bytes', () => {
		const result = verifyDocHubSignature({
			secret,
			timestamp,
			signature: sign(secret, timestamp, rawBody),
			rawBody: Buffer.from('{"type":"document.status_changed","id":"evt_2"}', 'utf8'),
			nowSeconds: NOW,
		});
		assert.equal(result.valid, false);
	});

	it('rejects a timestamp outside the five minute window', () => {
		const result = verifyDocHubSignature({
			secret,
			timestamp,
			signature: sign(secret, timestamp, rawBody),
			rawBody,
			nowSeconds: NOW + 301,
		});
		assert.equal(result.valid, false);
	});

	it('rejects a missing signature header', () => {
		const result = verifyDocHubSignature({
			secret,
			timestamp,
			signature: undefined,
			rawBody,
			nowSeconds: NOW,
		});
		assert.equal(result.valid, false);
	});
});

describe('parseWebhook', () => {
	it('reads a flat webhook payload, including the create-only secret', () => {
		const signingSecret = randomBytes(24).toString('hex');
		const webhook = parseWebhook({
			id: 'whk_abc',
			url: 'https://example.com/webhook',
			events: ['document.status_changed'],
			secret: signingSecret,
			enabled: true,
		});

		assert.equal(webhook.id, 'whk_abc');
		assert.equal(webhook.secret, signingSecret);
		assert.deepEqual(webhook.events, ['document.status_changed']);
	});

	it('reads a JSON:API webhook payload', () => {
		const webhook = parseWebhook({
			data: {
				id: 'whk_abc',
				type: 'webhooks',
				attributes: {
					url: 'https://example.com/webhook',
					events: ['signer.finalized'],
					enabled: false,
				},
			},
		});

		assert.equal(webhook.id, 'whk_abc');
		assert.equal(webhook.enabled, false);
		assert.equal(webhook.secret, undefined);
	});
});

describe('assertPublicHttpsUrl', () => {
	it('accepts a public HTTPS URL', () => {
		assert.doesNotThrow(() => assertPublicHttpsUrl('https://hooks.example.com/webhook/1'));
	});

	it('rejects localhost and private addresses', () => {
		assert.throws(() => assertPublicHttpsUrl('http://hooks.example.com/webhook'));
		assert.throws(() => assertPublicHttpsUrl('https://localhost:5678/webhook'));
		assert.throws(() => assertPublicHttpsUrl('https://127.0.0.1/webhook'));
		assert.throws(() => assertPublicHttpsUrl('https://10.1.1.1/webhook'));
	});
});

describe('document download helpers', () => {
	it('reads the presigned URL response', () => {
		assert.deepEqual(
			parsePdfUrl({
				url: 'https://download.production.dochub.com/file.pdf?X-Amz-Signature=abc',
				expiresIn: 3600,
			}),
			{
				url: 'https://download.production.dochub.com/file.pdf?X-Amz-Signature=abc',
				expiresIn: 3600,
			},
		);
	});

	it('rejects a non-HTTPS download URL', () => {
		assert.throws(() => parsePdfUrl({ url: 'http://download.example.com/file.pdf' }));
	});

	it('uses a safe PDF filename from Content-Disposition', () => {
		assert.equal(
			safePdfFileName('attachment; filename="Signed Contract.pdf"', 'doc_123'),
			'Signed Contract.pdf',
		);
		assert.equal(safePdfFileName(undefined, 'doc_123'), 'doc_123.pdf');
		assert.equal(
			safePdfFileName('attachment; filename="../secret.txt"', 'doc_123'),
			'secret.txt.pdf',
		);
	});
});
