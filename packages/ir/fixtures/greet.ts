export function greet(ports: { name: string }): { text: string } {
	return { text: `hello, ${ports.name}` };
}
