import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createdRoleId,
	fieldsToReassign,
	findRoleId,
	parseDocumentId,
	signRequestBody,
	unwrapResource,
} from '../nodes/DocHub/signRequest.ts';

describe('parseDocumentId', () => {
	it('returns a bare ID unchanged', () => {
		assert.equal(parseDocumentId('  mqNjP3BVW0doMPGw9yGzLk '), 'mqNjP3BVW0doMPGw9yGzLk');
	});

	it('reads the ID from a document URL', () => {
		assert.equal(
			parseDocumentId('https://dochub.com/siarhei-kisliak/mqNjP3BVW0doMPGw9yGzLk/t1'),
			'mqNjP3BVW0doMPGw9yGzLk',
		);
	});

	it('rejects a URL without a document ID', () => {
		assert.throws(() => parseDocumentId('https://dochub.com/settings'), /Could not find/);
	});
});

describe('roles', () => {
	const roles = { data: [{ id: 'roleClient', name: 'Client' }] };

	it('finds a role by name', () => {
		assert.equal(findRoleId(roles, 'Client'), 'roleClient');
	});

	it('returns undefined for a missing role', () => {
		assert.equal(findRoleId(roles, 'Manager'), undefined);
	});

	it('reads the created role from flat and wrapped responses', () => {
		assert.equal(createdRoleId({ id: 'roleNew' }), 'roleNew');
		assert.equal(createdRoleId({ data: { id: 'roleNew' } }), 'roleNew');
		assert.throws(() => createdRoleId({}), /did not return the created role/);
	});
});

describe('fieldsToReassign', () => {
	it('assigns only fields that are on another role or none', () => {
		const fields = {
			data: [
				{ id: 'fieldA', documentRoleId: 'roleClient' },
				{ id: 'fieldB', documentRoleId: 'roleOther' },
				{ id: 'fieldC', documentRoleId: null },
			],
		};
		assert.deepEqual(fieldsToReassign(fields, 'roleClient'), [
			{ id: 'fieldB', documentRoleId: 'roleClient' },
			{ id: 'fieldC', documentRoleId: 'roleClient' },
		]);
	});

	it('rejects a template without fields', () => {
		assert.throws(() => fieldsToReassign({ data: [] }, 'roleClient'), /no fields/);
	});
});

describe('signRequestBody', () => {
	const input = {
		templateId: 'mqNjP3BVW0doMPGw9yGzLk',
		roleName: 'Client',
		signerEmail: ' signer@example.com ',
		subject: 'Sign',
		message: 'Please sign',
	};

	it('binds the signer to the role by name', () => {
		assert.deepEqual(signRequestBody(input), {
			documentId: 'mqNjP3BVW0doMPGw9yGzLk',
			documentRoles: [{ name: 'Client', email: 'signer@example.com' }],
			emailContent: { subject: 'Sign', body: 'Please sign' },
		});
	});

	it('adds the signer name when given', () => {
		const body = signRequestBody({ ...input, signerName: 'Jane Doe' });
		assert.equal(body.documentRoles[0].signerName, 'Jane Doe');
	});
});

describe('unwrapResource', () => {
	it('returns the resource from flat and wrapped responses', () => {
		assert.deepEqual(unwrapResource({ id: 'sr1' }), { id: 'sr1' });
		assert.deepEqual(unwrapResource({ data: { id: 'sr1' } }), { id: 'sr1' });
	});
});
