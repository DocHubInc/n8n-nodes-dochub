import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { parsePdfUrl, safePdfFileName } from './dochub';
import { downloadPdf, dochubApiRequest, rethrowDocHubError } from './transport';

/**
 * Programmatic node: downloading a document is two dependent calls
 * (presigned URL, then the PDF bytes) and the result is binary.
 */
export class DocHub implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DocHub',
		name: 'docHub',
		icon: { light: 'file:dochub.png', dark: 'file:dochub.dark.png' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Download a DocHub document',
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
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
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
				const fileName = safePdfFileName(
					downloaded.contentDisposition,
					documentId,
					preferredName,
				);
				const binary = await this.helpers.prepareBinaryData(
					downloaded.buffer,
					fileName,
					'application/pdf',
				);

				returnData.push({
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
					pairedItem: { item: itemIndex },
				});
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
