import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { parsePdfUrl, safePdfFileName } from './dochub';
import type { SignerInput } from './signRequest';
import {
	assertValidSigners,
	createdRoleId,
	fieldAssignments,
	fieldOptions,
	parseDocumentId,
	readSigners,
	roleIdsByName,
	signRequestBody,
	unwrapResource,
} from './signRequest';
import { downloadPdf, dochubApiRequest, rethrowDocHubError } from './transport';

/**
 * Programmatic node: each operation is several dependent calls. Downloading a
 * document fetches a presigned URL, then the PDF bytes. Sending from a template
 * creates missing roles, reassigns fields, then creates the sign request.
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
				displayName: 'Signers',
				name: 'signers',
				type: 'fixedCollection',
				placeholder: 'Add Signer',
				required: true,
				default: {},
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				description: 'Who signs, and which template fields each of them fills',
				displayOptions: {
					show: {
						resource: ['signRequest'],
						operation: ['sendFromTemplate'],
					},
				},
				options: [
					{
						displayName: 'Signer',
						name: 'signer',
						values: [
							{
								displayName: 'Role Name',
								name: 'roleName',
								type: 'string',
								required: true,
								default: '',
								placeholder: 'Client',
								description:
									'Template role this signer fills. It is created on the template if it does not exist.',
							},
							{
								displayName: 'Email',
								name: 'email',
								type: 'string',
								required: true,
								default: '',
								placeholder: 'name@email.com',
							},
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Field Names or IDs',
								name: 'fields',
								type: 'multiOptions',
								typeOptions: {
									loadOptionsMethod: 'getTemplateFields',
									loadOptionsDependsOn: ['templateId'],
								},
								default: [],
								description:
									'Template fields assigned to this signer\'s role before sending. Leave empty to keep the template\'s assignments. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
							},
						],
					},
				],
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
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						resource: ['signRequest'],
						operation: ['sendFromTemplate'],
					},
				},
				options: [
					{
						displayName: 'Sign in Order',
						name: 'signInOrder',
						type: 'boolean',
						default: false,
						description:
							'Whether signers sign one after another, in the order listed. Otherwise everyone is invited at once.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			getTemplateFields,
		},
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
	if (!templateId) {
		throw new NodeOperationError(this.getNode(), 'Template is required', { itemIndex });
	}

	const signers = readSigners(this.getNodeParameter('signers.signer', itemIndex, []));
	try {
		assertValidSigners(signers);
	} catch (error) {
		throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
	}
	const options = this.getNodeParameter('options', itemIndex, {}) as { signInOrder?: boolean };

	await prepareTemplateRoles.call(this, templateId, signers);

	const signRequest = await dochubApiRequest.call(
		this,
		'POST',
		'/sign-requests',
		signRequestBody({
			templateId,
			signers,
			signInOrder: options.signInOrder === true,
			subject: this.getNodeParameter('subject', itemIndex) as string,
			message: this.getNodeParameter('message', itemIndex) as string,
		}),
	);

	return { json: unwrapResource(signRequest) as IDataObject };
}

async function prepareTemplateRoles(
	this: IExecuteFunctions,
	templateId: string,
	signers: SignerInput[],
): Promise<void> {
	const filter = documentFilter(templateId);
	const roleIds = roleIdsByName(
		await dochubApiRequest.call(this, 'GET', `/document-roles?${filter}`),
	);

	for (const [index, signer] of signers.entries()) {
		if (roleIds.has(signer.roleName)) continue;

		const created = await dochubApiRequest.call(this, 'POST', '/document-roles', {
			documentId: templateId,
			name: signer.roleName,
			queuePosition: index + 1,
		});
		roleIds.set(signer.roleName, createdRoleId(created));
	}

	if (signers.every((signer) => signer.fields.length === 0)) return;

	const fields = await dochubApiRequest.call(this, 'GET', `/formfields?${filter}`);
	const assignments = fieldAssignments(fields, signers, roleIds);
	if (assignments.length > 0) {
		await dochubApiRequest.call(this, 'POST', '/formfields/bulk-update', { data: assignments });
	}
}

async function getTemplateFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const template = this.getCurrentNodeParameter('templateId');
	if (typeof template !== 'string' || template.trim() === '') return [];

	const filter = documentFilter(parseDocumentId(template));
	const [fields, roles] = await Promise.all([
		dochubApiRequest.call(this, 'GET', `/formfields?${filter}`),
		dochubApiRequest.call(this, 'GET', `/document-roles?${filter}`),
	]);
	return fieldOptions(fields, roles);
}

function documentFilter(documentId: string): string {
	return `filter%5BdocumentId%5D=${encodeURIComponent(documentId)}`;
}
