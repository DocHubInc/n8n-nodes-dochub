import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	DOCHUB_EVENTS,
	DOCHUB_PING_EVENT,
	assertKnownEvents,
	assertPublicHttpsUrl,
	parseWebhook,
	readEvents,
	sameStringSet,
	singleHeader,
	verifyDocHubSignature,
} from '../DocHub/dochub';
import { dochubApiRequest, getStatusCode, rethrowDocHubError } from '../DocHub/transport';

/**
 * Programmatic trigger: activation creates the DocHub webhook, and each
 * delivery is verified against the raw body before the workflow starts.
 */
export class DocHubTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DocHub Trigger',
		name: 'docHubTrigger',
		icon: { light: 'file:dochubTrigger.png', dark: 'file:dochubTrigger.dark.png' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Start a workflow when a DocHub event occurs',
		defaults: {
			name: 'DocHub Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'docHubApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Activating this workflow creates a DocHub webhook for the events below and removes it when the workflow is turned off. The URL must be public HTTPS. For local testing, open a tunnel and set WEBHOOK_URL to that address.',
				name: 'activationNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [...DOCHUB_EVENTS],
				default: [
					'document.created',
					'document.shared',
					'document.status_changed',
					'sign_request.created',
					'sign_request.voided',
					'signer.finalized',
					'signer.rejected',
				],
				description: 'DocHub events that start this workflow',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const webhookUrl = requireWebhookUrl(this);
				const events = selectedEvents(this);
				const webhookId = readStoredId(staticData);
				if (!webhookId) return false;

				try {
					const existing = parseWebhook(
						await dochubApiRequest.call(this, 'GET', `/webhooks/${encodeURIComponent(webhookId)}`),
					);
					const matches =
						existing.url === webhookUrl &&
						existing.enabled !== false &&
						sameStringSet(existing.events, events);

					if (!matches) {
						await deleteRemoteWebhook(this, webhookId);
						clearStoredWebhook(staticData);
						return false;
					}

					if (!readStoredSecret(staticData)) {
						await storeRotatedSecret(this, staticData, webhookId);
					}

					return true;
				} catch (error) {
					if (getStatusCode(error) === 404) {
						clearStoredWebhook(staticData);
						return false;
					}

					rethrowDocHubError(this.getNode(), error);
				}
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const webhookUrl = requireWebhookUrl(this);
				const events = selectedEvents(this);
				const workflowName = this.getWorkflow().name ?? 'workflow';

				try {
					const created = parseWebhook(
						await dochubApiRequest.call(this, 'POST', '/webhooks', {
							name: `n8n ${workflowName}`.slice(0, 80),
							url: webhookUrl,
							description: 'Created by the n8n DocHub Trigger',
							events,
						}),
					);

					if (!created.secret) {
						await deleteRemoteWebhook(this, created.id);
						throw new NodeOperationError(
							this.getNode(),
							'DocHub created the webhook without returning a signing secret',
						);
					}

					staticData.webhookId = created.id;
					staticData.webhookSecret = created.secret;
					return true;
				} catch (error) {
					rethrowDocHubError(this.getNode(), error);
				}
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const webhookId = readStoredId(staticData);
				if (webhookId) {
					await deleteRemoteWebhook(this, webhookId);
				}

				clearStoredWebhook(staticData);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const secret = readStoredSecret(this.getWorkflowStaticData('node'));
		const request = this.getRequestObject();
		if (!request.rawBody) {
			await request.readRawBody();
		}

		const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.alloc(0);
		const signatureOk =
			secret !== undefined &&
			verifyDocHubSignature({
				secret,
				timestamp: singleHeader(request.headers['x-dochub-timestamp']),
				signature: singleHeader(request.headers['x-dochub-signature-256']),
				rawBody,
			}).valid;

		if (!signatureOk) {
			return rejectRequest(this, 401);
		}

		const body = this.getBodyData();
		const headerEvent = singleHeader(request.headers['x-dochub-event']);
		const bodyType = typeof body.type === 'string' ? body.type : undefined;
		if (!bodyType || (headerEvent && headerEvent !== bodyType)) {
			return rejectRequest(this, 400);
		}

		if (bodyType === DOCHUB_PING_EVENT) {
			return acknowledge(this);
		}

		const events = readEvents(this.getNodeParameter('events', []));
		if (!events.includes(bodyType)) {
			return acknowledge(this);
		}

		const deliveryId = singleHeader(request.headers['x-dochub-delivery-id']);
		return {
			workflowData: [
				[
					{
						json: {
							...body,
							...(deliveryId ? { deliveryId } : {}),
						},
					},
				],
			],
		};
	}
}

function selectedEvents(context: IHookFunctions): string[] {
	const events = readEvents(context.getNodeParameter('events', []));
	try {
		assertKnownEvents(events);
	} catch (error) {
		throw new NodeOperationError(
			context.getNode(),
			error instanceof Error ? error.message : 'Select at least one DocHub event',
		);
	}
	return events;
}

function requireWebhookUrl(context: IHookFunctions): string {
	const webhookUrl = context.getNodeWebhookUrl('default');
	if (!webhookUrl) {
		throw new NodeOperationError(context.getNode(), 'n8n did not provide a webhook URL');
	}

	try {
		assertPublicHttpsUrl(webhookUrl);
	} catch (error) {
		throw new NodeOperationError(
			context.getNode(),
			error instanceof Error ? error.message : 'Invalid webhook URL',
		);
	}

	return webhookUrl;
}

async function storeRotatedSecret(
	context: IHookFunctions,
	staticData: IDataObject,
	webhookId: string,
): Promise<void> {
	const rotated = parseWebhook(
		await dochubApiRequest.call(
			context,
			'POST',
			`/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`,
		),
	);
	if (!rotated.secret) {
		throw new NodeOperationError(
			context.getNode(),
			'DocHub did not return a signing secret when rotating the webhook secret',
		);
	}

	staticData.webhookSecret = rotated.secret;
}

async function deleteRemoteWebhook(context: IHookFunctions, webhookId: string): Promise<void> {
	try {
		await dochubApiRequest.call(context, 'DELETE', `/webhooks/${encodeURIComponent(webhookId)}`);
	} catch (error) {
		if (getStatusCode(error) === 404) return;
		rethrowDocHubError(context.getNode(), error);
	}
}

function readStoredId(staticData: IDataObject): string | undefined {
	return typeof staticData.webhookId === 'string' && staticData.webhookId.length > 0
		? staticData.webhookId
		: undefined;
}

function readStoredSecret(staticData: IDataObject): string | undefined {
	return typeof staticData.webhookSecret === 'string' && staticData.webhookSecret.length > 0
		? staticData.webhookSecret
		: undefined;
}

function clearStoredWebhook(staticData: IDataObject): void {
	delete staticData.webhookId;
	delete staticData.webhookSecret;
}

function rejectRequest(context: IWebhookFunctions, statusCode: 400 | 401): IWebhookResponseData {
	context
		.getResponseObject()
		.status(statusCode)
		.json({ message: statusCode === 401 ? 'Unauthorized' : 'Bad Request' });
	return { noWebhookResponse: true };
}

function acknowledge(context: IWebhookFunctions): IWebhookResponseData {
	context.getResponseObject().status(200).json({ received: true });
	return { noWebhookResponse: true };
}
