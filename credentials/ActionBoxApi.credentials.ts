import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ActionBoxApi implements ICredentialType {
	name = 'actionBoxApi';
	displayName = 'ActionBox API';
	documentationUrl = 'https://actionbox.cloud/docs/api-authentication';
	icon = 'file:../nodes/ActionBox/actionbox.svg' as const;
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.actionbox.cloud',
			url: '=/v1/source/actions/{{encodeURIComponent($credentials.testActionId)}}',
			method: 'GET',
		},
	};
	properties: INodeProperties[] = [
		{
			displayName: 'Test Action ID',
			name: 'testActionId',
			type: 'string',
			default: '',
			description:
				'An existing Action owned by this Source, used only by the credential connection test. Leave empty until you have created an Action.',
		},
		{
			displayName: 'Source Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'The live Source key from ActionBox',
		},
		{
			displayName: 'Webhook Signing Secret',
			name: 'webhookSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'The signing secret for the same Source. Required for Request Approval and Wait.',
		},
		{
			displayName:
				'Use Get Action with an Action owned by this Source to check authentication. A health check cannot validate a Source key.',
			name: 'authNotice',
			type: 'notice',
			default: '',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};
}
