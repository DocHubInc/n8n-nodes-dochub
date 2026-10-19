import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { parsePdfUrl, safePdfFileName } from './dochub';
import {
	createdRoleId,
	fieldsToReassign,
	findRoleId,
	parseDocumentId,
	signRequestBody,
	unwrapResource,
} from './signRequest';
import { downloadPdf, dochubApiRequest, rethrowDocHubError } from './transport';

/**
 * Programmatic node: each operation is several dependent calls. Downloading a
 * document fetches a presigned URL, then the PDF bytes. Sending from a template
 * reads roles and fields, reassigns fields, then creates the sign request.
 */
export class DocHub implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DocHub',
		name: 'docHub',
		icon: { light: 'file:dochub.png', dark: 'file:dochub.dark.png' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Download DocHub documents and send sign requests',
		defaults: {
			name: 'DocHub',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'docHubApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Document',
						value: 'document',
					},
					{
						name: 'Sign Request',
						value: 'signRequest',
					},
				],
				default: 'document',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['document'],
					},
				},
				options: [
					{
						name: 'Download',
						value: 'download',
						action: 'Download a document',
						description: 'Download the compiled PDF of a document',
					},
				],
				default: 'download',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['signRequest'],
					},
				},
				options: [
					{
						name: 'Send From Template',
						value: 'sendFromTemplate',
						action: 'Send a sign request from a template',
						description: 'Copy a template, assign its fields to one role, and send it to a signer',
					},
				],
				default: 'sendFromTemplate',
			},
			{
				displayName: 'Document ID',
				name: 'documentId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'doc_xxxxxxxx',
				description:
					'Document identifier. From a DocHub Trigger item, this is usually data.document.ID.',
				displayOptions: {
					show: {
						resource: ['document'],
						operation: ['download'],
					},
				},
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				placeholder: 'Signed Contract.pdf',
				description:
					'Name for the downloaded PDF. Leave empty to use the name DocHub sends, or the document ID when DocHub does not send one.',
				displayOptions: {
					show: {
						resource: ['document'],
						operation: ['download'],
					},
				},
			},
			{
				displayName: 'Template',
				name: 'templateId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://dochub.com/your-name/mqNjP3BVW0doMPGw9yGzLk/contract',
				description: 'Template URL or ID. DocHub sends a copy and keeps the template.',
				displayOptions: {
					show: {
						resource: ['signRequest'],
						operation: ['sendFromTemplate'],
					},
				},
			},
			{
				displayName: 'Signer Email',
				name: 'signerEmail',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'name@email.com',
				displayOptions: {
					show: {
						resource: ['signRequest'],
						operation: ['sendFromTemplate'],
					},
				},
			},
			{
				displayName: 'Role Name',
				name: 'roleName',
				type: 'string',
				required: true,
				default: 'Client',
				description:
					'Template role the signer fills. It is created on the template if it does not exist.',
				displayOptions: {
					show: {
						resource: ['signRequest'],
						operation: ['sendFromTemplate'],
					},
				},
			},
			{
				displayName: 'Email Subject',
				name: 'subject',
				type: 'string',
				required: true,
				default: 'Please sign this document',
				displayOptions: {
					show: {
						resource: ['signRequest'],
						operation: ['sendFromTemplate'],
					},
				},
			},
			{
				displayName: 'Email Message',
				name: 'message',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: 'Please review and sign this document.',
				displayOptions: {
					show: {
						resource: ['signRequest'],
						operation: ['sendFromTemplate'],
					},
				},
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: {
						resource: ['signRequest'],
						operation: ['sendFromTemplate'],
					},
				},
				options: [
					{
						displayName: 'Assign All Fields to Role',
						name: 'assignAllFields',
						type: 'boolean',
						default: true,
						description:
							'Whether to assign every template field to the role before sending. This changes the template.',
					},
					{
						displayName: 'Signer Name',
						name: 'signerName',
						type: 'string',
						default: '',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const item =
					resource === 'signRequest'
						? await sendFromTemplate.call(this, itemIndex)
						: await downloadDocument.call(this, itemIndex);
				returnData.push({ ...item, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error instanceof Error ? error.message : 'DocHub request failed',
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				rethrowDocHubError(this.getNode(), error, itemIndex);
			}
		}

		return [returnData];
	}
}

async function downloadDocument(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const documentId = (this.getNodeParameter('documentId', itemIndex) as string).trim();
	if (!documentId) {
		throw new NodeOperationError(this.getNode(), 'Document ID is required', { itemIndex });
	}

	const metadata = parsePdfUrl(
		await dochubApiRequest.call(
			this,
			'GET',
			`/documents/${encodeURIComponent(documentId)}/pdf-url`,
		),
	);
	const downloaded = await downloadPdf.call(this, metadata.url);
	const preferredName = this.getNodeParameter('fileName', itemIndex, '') as string;
	const fileName = safePdfFileName(downloaded.contentDisposition, documentId, preferredName);
	const binary = await this.helpers.prepareBinaryData(
		downloaded.buffer,
		fileName,
		'application/pdf',
	);

	return {
		json: {
			documentId,
			fileName,
			mimeType: 'application/pdf',
			fileSize: downloaded.buffer.length,
			expiresIn: metadata.expiresIn,
		},
		binary: {
			data: binary,
		},
	};
}

async function sendFromTemplate(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const templateId = parseDocumentId(this.getNodeParameter('templateId', itemIndex) as string);
	const roleName = (this.getNodeParameter('roleName', itemIndex) as string).trim();
	const signerEmail = (this.getNodeParameter('signerEmail', itemIndex) as string).trim();
	const additionalFields = this.getNodeParameter('additionalFields', itemIndex, {}) as {
		assignAllFields?: boolean;
		signerName?: string;
	};
	if (!templateId) {
		throw new NodeOperationError(this.getNode(), 'Template is required', { itemIndex });
	}
	if (!roleName) {
		throw new NodeOperationError(this.getNode(), 'Role Name is required', { itemIndex });
	}
	if (!signerEmail) {
		throw new NodeOperationError(this.getNode(), 'Signer Email is required', { itemIndex });
	}

	if (additionalFields.assignAllFields !== false) {
		await assignAllFieldsToRole.call(this, templateId, roleName);
	}

	const signRequest = await dochubApiRequest.call(
		this,
		'POST',
		'/sign-requests',
		signRequestBody({
			templateId,
			roleName,
			signerEmail,
			signerName: additionalFields.signerName,
			subject: this.getNodeParameter('subject', itemIndex) as string,
			message: this.getNodeParameter('message', itemIndex) as string,
		}),
	);

	return { json: unwrapResource(signRequest) as IDataObject };
}

async function assignAllFieldsToRole(
	this: IExecuteFunctions,
	templateId: string,
	roleName: string,
): Promise<void> {
	const documentFilter = `filter%5BdocumentId%5D=${encodeURIComponent(templateId)}`;
	const roles = await dochubApiRequest.call(this, 'GET', `/document-roles?${documentFilter}`);
	const roleId =
		findRoleId(roles, roleName) ??
		createdRoleId(
			await dochubApiRequest.call(this, 'POST', '/document-roles', {
				documentId: templateId,
				name: roleName,
				queuePosition: 1,
			}),
		);

	const fields = await dochubApiRequest.call(this, 'GET', `/formfields?${documentFilter}`);
	const assignments = fieldsToReassign(fields, roleId);
	if (assignments.length > 0) {
		await dochubApiRequest.call(this, 'POST', '/formfields/bulk-update', { data: assignments });
	}
}
