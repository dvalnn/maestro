// stand-in SDK: host and pack each get their own copy
export class CodeNode {
  readonly kind = "code";
  constructor(readonly id: string, readonly run: (input: unknown) => unknown) {}
}
export const code = (id: string, run: (input: unknown) => unknown) => new CodeNode(id, run);
