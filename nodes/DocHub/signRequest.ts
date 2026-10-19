export type FieldRoleAssignment = { id: string; documentRoleId: string };

export type SignRequestInput = {
	templateId: string;
	roleName: string;
	signerEmail: string;
	signerName?: string;
	subject: string;
	message: string;
};

const HASHID_PATTERN = /^[A-Za-z0-9]{22}$/;

export function parseDocumentId(input: string): string {
	const trimmed = input.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return trimmed;
	}

	const documentId = url.pathname.split('/').find((segment) => HASHID_PATTERN.test(segment));
	if (!documentId) {
		throw new Error(`Could not find a document ID in ${trimmed}`);
	}
	return documentId;
}

export function findRoleId(payload: unknown, roleName: string): string | undefined {
	const role = readList(payload).find((item) => item.name === roleName);
	return readString(role?.id);
}

export function createdRoleId(payload: unknown): string {
	const record = asRecord(payload);
	const role = asRecord(record?.data) ?? record;
	const id = readString(role?.id);
	if (!id) {
		throw new Error('DocHub did not return the created role');
	}
	return id;
}

export function fieldsToReassign(payload: unknown, roleId: string): FieldRoleAssignment[] {
	const fields = readList(payload);
	if (fields.length === 0) {
		throw new Error('The template has no fields to assign');
	}

	return fields
		.filter((field) => field.documentRoleId !== roleId)
		.map((field) => ({ id: String(field.id), documentRoleId: roleId }));
}

export function signRequestBody(input: SignRequestInput) {
	const signerName = input.signerName?.trim();
	return {
		documentId: input.templateId,
		documentRoles: [
			{
				name: input.roleName,
				email: input.signerEmail.trim(),
				...(signerName ? { signerName } : {}),
			},
		],
		emailContent: { subject: input.subject, body: input.message },
	};
}

export function unwrapResource(payload: unknown): Record<string, unknown> {
	const record = asRecord(payload);
	if (!record) {
		throw new Error('DocHub returned a response that was not an object');
	}
	return asRecord(record.data) ?? record;
}

function readList(payload: unknown): Record<string, unknown>[] {
	const data = asRecord(payload)?.data;
	if (!Array.isArray(data)) {
		throw new Error('DocHub returned a list response without data');
	}
	return data.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined);
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
