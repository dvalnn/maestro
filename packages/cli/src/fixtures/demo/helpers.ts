// Exported functions that code nodes name. Builds never call them.

export function exclaim(inputs: { text: string }): { text: string } {
	return { text: `${inputs.text}!` };
}
