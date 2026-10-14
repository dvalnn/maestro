export function isDone(ports: { text: string }): { value: boolean } {
	return { value: ports.text.endsWith(".") };
}
