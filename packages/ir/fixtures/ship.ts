export function plan(): { spec: string; risky: boolean } {
	return { spec: "add a flag", risky: true };
}

export function implement(ports: { spec: string }): { patch: string } {
	return { patch: ports.spec };
}

export function writeTests(ports: { spec: string }): { tests: string } {
	return { tests: ports.spec };
}

export function verify(ports: { patch: string; tests: string }): {
	verdict: string;
} {
	return { verdict: ports.patch + ports.tests };
}

export function audit(ports: { patch: string }): { note: string } {
	return { note: ports.patch };
}

export function report(ports: { verdict: string; note: string }): {
	text: string;
} {
	return { text: ports.verdict + ports.note };
}
