export const ALL_FIELDS = '__all__';

export type FieldRoleAssignment = { id: string; documentRoleId: string };

export type SignerInput = {
	roleName: string;
	email: string;
	name?: string;
	fields: string[];
};

export type SignRequestInput = {
	templateId: string;
	signers: SignerInput[];
	signInOrder: boolean;
	subject: string;
	message: string;
};

const HASHID_PATTERN = /^[A-Za-z0-9]{22}$/;

const FIELD_TYPE_NAMES: Record<string, string> = {
	ftButton: 'Button',
	ftCheckBox: 'Checkbox',
	ftRadioBtn: 'Radio Button',
	ftComboBox: 'Dropdown',
	ftListBox: 'List',
	ftText: 'Text',
	ftSignature: 'Signature',
	dhSignature: 'Signature',
	dhInitials: 'Initials',
	dhAutoDate: 'Date',
	dhFileAttachment: 'File Attachment',
	dhImageField: 'Image',
};

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

export function readSigners(value: unknown): SignerInput[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => {
		const record = asRecord(item) ?? {};
		const name = readString(record.name)?.trim();
		return {
			roleName: (readString(record.roleName) ?? '').trim(),
			email: (readString(record.email) ?? '').trim(),
			...(name ? { name } : {}),
			fields: readFieldIds(record.fields),
		};
	});
}

export function assertValidSigners(signers: SignerInput[]): void {
	if (signers.length === 0) {
		throw new Error('Add at least one signer');
	}

	const roleNames = new Set<string>();
	signers.forEach((signer, index) => {
		const label = `Signer ${index + 1}`;
		if (!signer.roleName) throw new Error(`${label} needs a role name`);
		if (!signer.email) throw new Error(`${label} needs an email`);
		const roleKey = signer.roleName.toLocaleLowerCase();
		if (roleNames.has(roleKey)) {
			throw new Error(`Role "${signer.roleName}" is used by more than one signer`);
		}
		roleNames.add(roleKey);
	});

	const allFieldsSigners = signers.filter((signer) => signer.fields.includes(ALL_FIELDS));
	if (allFieldsSigners.length > 1) {
		throw new Error('Only one signer can take All Fields');
	}
}

export function roleIdsByName(payload: unknown): Map<string, string> {
	const roles = new Map<string, string>();
	for (const role of readList(payload)) {
		const name = readString(role.name);
		const id = readString(role.id);
		if (name && id) roles.set(name, id);
	}
	return roles;
}

export function matchRoleName(roleIds: Map<string, string>, roleName: string): string | undefined {
	if (roleIds.has(roleName)) return roleName;

	const wanted = roleName.toLocaleLowerCase();
	for (const name of roleIds.keys()) {
		if (name.toLocaleLowerCase() === wanted) return name;
	}
	return undefined;
}

export function createdRoleId(payload: unknown): string {
	const role = unwrapResource(payload);
	const id = readString(role.id);
	if (!id) {
		throw new Error('DocHub did not return the created role');
	}
	return id;
}

export function fieldOptions(
	fieldsPayload: unknown,
	rolesPayload: unknown,
): { name: string; value: string }[] {
	const roleNames = new Map(
		[...roleIdsByName(rolesPayload)].map(([name, id]) => [id, name] as const),
	);

	const options = readList(fieldsPayload).map((field, index) => {
		const id = String(field.id);
		const label = readString(field.autofillKey) ?? `Field ${index + 1}`;
		const type = FIELD_TYPE_NAMES[String(field.ffType)] ?? String(field.ffType);
		const role = roleNames.get(String(field.documentRoleId));
		return { name: `${label} - ${type}${role ? ` (${role})` : ''}`, value: id };
	});

	return [{ name: 'All Fields', value: ALL_FIELDS }, ...options];
}

export function fieldAssignments(
	fieldsPayload: unknown,
	signers: SignerInput[],
	roleIds: Map<string, string>,
): FieldRoleAssignment[] {
	const fields = readList(fieldsPayload);
	const fieldIds = new Set(fields.map((field) => String(field.id)));
	const targetRoleByField = new Map<string, string>();

	for (const signer of signers) {
		for (const fieldId of signer.fields) {
			if (fieldId === ALL_FIELDS) continue;
			if (!fieldIds.has(fieldId)) {
				throw new Error(`Field ${fieldId} is not on the template`);
			}
			if (targetRoleByField.has(fieldId)) {
				throw new Error(`Field ${fieldId} is selected for more than one signer`);
			}
			targetRoleByField.set(fieldId, roleIdFor(roleIds, signer.roleName));
		}
	}

	const allFieldsSigner = signers.find((signer) => signer.fields.includes(ALL_FIELDS));
	if (allFieldsSigner) {
		const roleId = roleIdFor(roleIds, allFieldsSigner.roleName);
		for (const fieldId of fieldIds) {
			if (!targetRoleByField.has(fieldId)) targetRoleByField.set(fieldId, roleId);
		}
	}

	return fields
		.map((field) => ({ id: String(field.id), current: field.documentRoleId }))
		.filter(({ id, current }) => {
			const target = targetRoleByField.get(id);
			return target !== undefined && target !== current;
		})
		.map(({ id }) => ({ id, documentRoleId: targetRoleByField.get(id) as string }));
}

export function signRequestBody(input: SignRequestInput) {
	return {
		documentId: input.templateId,
		...(input.signInOrder ? { hasQueue: true } : {}),
		documentRoles: input.signers.map((signer, index) => ({
			name: signer.roleName,
			email: signer.email,
			...(signer.name ? { signerName: signer.name } : {}),
			...(input.signInOrder ? { queuePosition: index + 1 } : {}),
		})),
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

function roleIdFor(roleIds: Map<string, string>, roleName: string): string {
	const roleId = roleIds.get(roleName);
	if (!roleId) {
		throw new Error(`The template has no role named "${roleName}"`);
	}
	return roleId;
}

function readFieldIds(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
	}
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((id) => id.trim())
			.filter((id) => id.length > 0);
	}
	return [];
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
