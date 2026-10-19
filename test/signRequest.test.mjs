import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	ALL_FIELDS,
	assertValidSigners,
	createdRoleId,
	fieldAssignments,
	fieldOptions,
	parseDocumentId,
	readSigners,
	roleIdsByName,
	signRequestBody,
	unwrapResource,
} from '../nodes/DocHub/signRequest.ts';

const roles = {
	data: [
		{ id: 'roleClient', name: 'Client' },
		{ id: 'roleManager', name: 'Manager' },
	],
};

const fields = {
	data: [
		{
			id: 'fieldSign',
			ffType: 'dhSignature',
			autofillKey: 'signature',
			documentRoleId: 'roleClient',
		},
		{ id: 'fieldName', ffType: 'ftText', autofillKey: 'full_name', documentRoleId: 'roleClient' },
		{ id: 'fieldDate', ffType: 'dhAutoDate', autofillKey: null, documentRoleId: null },
	],
};

const roleIds = new Map([
	['Client', 'roleClient'],
	['Manager', 'roleManager'],
]);

const signer = (roleName, fieldIds = []) => ({
	roleName,
	email: `${roleName.toLowerCase()}@example.com`,
	fields: fieldIds,
});

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

describe('readSigners', () => {
	it('trims values and accepts field IDs as a list or a comma-separated expression', () => {
		assert.deepEqual(
			readSigners([
				{ roleName: ' Client ', email: ' a@example.com ', name: '', fields: ['fieldSign'] },
				{
					roleName: 'Manager',
					email: 'b@example.com',
					name: 'Bob',
					fields: 'fieldName, fieldDate',
				},
			]),
			[
				{ roleName: 'Client', email: 'a@example.com', fields: ['fieldSign'] },
				{
					roleName: 'Manager',
					email: 'b@example.com',
					name: 'Bob',
					fields: ['fieldName', 'fieldDate'],
				},
			],
		);
	});

	it('returns no signers when the parameter is missing', () => {
		assert.deepEqual(readSigners(undefined), []);
	});
});

describe('assertValidSigners', () => {
	it('accepts distinct roles', () => {
		assert.doesNotThrow(() => assertValidSigners([signer('Client'), signer('Manager')]));
	});

	it('requires at least one signer', () => {
		assert.throws(() => assertValidSigners([]), /at least one signer/);
	});

	it('requires a role name and an email', () => {
		assert.throws(() => assertValidSigners([{ ...signer('Client'), roleName: '' }]), /role name/);
		assert.throws(() => assertValidSigners([{ ...signer('Client'), email: '' }]), /email/);
	});

	it('rejects a role used twice', () => {
		assert.throws(
			() => assertValidSigners([signer('Client'), signer('Client')]),
			/more than one signer/,
		);
	});

	it('allows All Fields on one signer only', () => {
		assert.throws(
			() => assertValidSigners([signer('Client', [ALL_FIELDS]), signer('Manager', [ALL_FIELDS])]),
			/Only one signer/,
		);
	});
});

describe('roles', () => {
	it('maps role names to IDs', () => {
		assert.deepEqual(roleIdsByName(roles), roleIds);
	});

	it('reads the created role from flat and wrapped responses', () => {
		assert.equal(createdRoleId({ id: 'roleNew' }), 'roleNew');
		assert.equal(createdRoleId({ data: { id: 'roleNew' } }), 'roleNew');
		assert.throws(() => createdRoleId({}), /did not return the created role/);
	});
});

describe('fieldOptions', () => {
	it('lists All Fields, then each field with its type and current role', () => {
		assert.deepEqual(fieldOptions(fields, roles), [
			{ name: 'All Fields', value: ALL_FIELDS },
			{ name: 'signature - Signature (Client)', value: 'fieldSign' },
			{ name: 'full_name - Text (Client)', value: 'fieldName' },
			{ name: 'Field 3 - Date', value: 'fieldDate' },
		]);
	});
});

describe('fieldAssignments', () => {
	it('moves selected fields to each signer role and skips ones already there', () => {
		const signers = [
			signer('Client', ['fieldSign']),
			signer('Manager', ['fieldName', 'fieldDate']),
		];
		assert.deepEqual(fieldAssignments(fields, signers, roleIds), [
			{ id: 'fieldName', documentRoleId: 'roleManager' },
			{ id: 'fieldDate', documentRoleId: 'roleManager' },
		]);
	});

	it('gives All Fields only the fields no other signer picked', () => {
		const signers = [signer('Manager', [ALL_FIELDS]), signer('Client', ['fieldSign'])];
		assert.deepEqual(fieldAssignments(fields, signers, roleIds), [
			{ id: 'fieldName', documentRoleId: 'roleManager' },
			{ id: 'fieldDate', documentRoleId: 'roleManager' },
		]);
	});

	it('leaves fields nobody picked unchanged', () => {
		assert.deepEqual(fieldAssignments(fields, [signer('Manager', ['fieldDate'])], roleIds), [
			{ id: 'fieldDate', documentRoleId: 'roleManager' },
		]);
	});

	it('rejects a field picked for two signers', () => {
		const signers = [signer('Client', ['fieldDate']), signer('Manager', ['fieldDate'])];
		assert.throws(() => fieldAssignments(fields, signers, roleIds), /more than one signer/);
	});

	it('rejects a field that is not on the template', () => {
		assert.throws(
			() => fieldAssignments(fields, [signer('Client', ['fieldOther'])], roleIds),
			/not on the template/,
		);
	});
});

describe('signRequestBody', () => {
	const input = {
		templateId: 'mqNjP3BVW0doMPGw9yGzLk',
		signers: [signer('Client'), { ...signer('Manager'), name: 'Bob' }],
		signInOrder: false,
		subject: 'Sign',
		message: 'Please sign',
	};

	it('binds each signer to a role by name', () => {
		assert.deepEqual(signRequestBody(input), {
			documentId: 'mqNjP3BVW0doMPGw9yGzLk',
			documentRoles: [
				{ name: 'Client', email: 'client@example.com' },
				{ name: 'Manager', email: 'manager@example.com', signerName: 'Bob' },
			],
			emailContent: { subject: 'Sign', body: 'Please sign' },
		});
	});

	it('queues signers in list order when signing in order', () => {
		const body = signRequestBody({ ...input, signInOrder: true });
		assert.equal(body.hasQueue, true);
		assert.deepEqual(
			body.documentRoles.map((role) => role.queuePosition),
			[1, 2],
		);
	});
});

describe('unwrapResource', () => {
	it('returns the resource from flat and wrapped responses', () => {
		assert.deepEqual(unwrapResource({ id: 'sr1' }), { id: 'sr1' });
		assert.deepEqual(unwrapResource({ data: { id: 'sr1' } }), { id: 'sr1' });
	});
});
