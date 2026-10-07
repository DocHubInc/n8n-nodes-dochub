import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class DocHubApi implements ICredentialType {
	name = 'docHubApi';

	displayName = 'DocHub API';

	icon = {
		light: 'file:../nodes/DocHub/dochub.png',
		dark: 'file:../nodes/DocHub/dochub.dark.png',
	} as const;

	documentationUrl = 'https://dev.dochub.com/docs/authentication/api-key';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'DocHub API key sent in the X-API-Token header',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Token': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://dochub.com/api/v2',
			url: '/users/current',
			method: 'GET',
			headers: {
				Accept: 'application/json',
			},
		},
	};
}
